-- Smoke-Test der Datenbankobjekte der Beispiel-App (SQLcl, als Parsing Schema, aus dem Projektordner):
--   sql -S -name <verbindung> @tests/smoke_test.sql
-- Ändert nichts: alles läuft in einer Transaktion, die am Ende zurückgerollt wird.
set exitcommit off
set define off
set feedback off
set serveroutput on size unlimited
whenever sqlerror exit failure rollback

declare
    l_fehler  pls_integer := 0;
    l_auftrag oe_auftrag.id%type;
    l_jpeg    blob;
    l_url     clob;
    l_bild    blob;
    l_mime    varchar2(30);
    l_id1     number;
    l_id2     number;
    l_anzahl  pls_integer;
    l_text    oe_auftrag_foto.bemerkung%type;

    procedure pruefe(p_ok in boolean, p_text in varchar2) is
    begin
        dbms_output.put_line(case when p_ok then '  [OK]     ' else '  [FEHLER] ' end || p_text);
        if p_ok is null or not p_ok then
            l_fehler := l_fehler + 1;
        end if;
    end pruefe;

    -- Data-URL wie im Browser: Base64 ohne Zeilenumbrüche
    function data_url(p_kopf in varchar2, p_bytes in blob) return clob is
        l_clob clob := to_clob(p_kopf);
    begin
        dbms_lob.append(l_clob, apex_web_service.blob2clobbase64(p_bytes, p_newlines => 'N'));
        return l_clob;
    end data_url;

    procedure erwarte_fehler(p_url in clob, p_code in number, p_text in varchar2) is
        l_b blob;
        l_m varchar2(30);
    begin
        l_b := pck_oe_auftrag_foto_dml.bild_aus_data_url(p_url, l_m);
        pruefe(false, p_text || ': kein Fehler');
    exception
        when others then
            pruefe(sqlcode = p_code, p_text || ': ' || sqlerrm);
    end erwarte_fehler;
begin
    dbms_output.put_line('Fotos: Data-URL -> Bild');
    dbms_lob.createtemporary(l_jpeg, true);
    dbms_lob.append(l_jpeg, hextoraw('FFD8FFE000104A46494600'));
    for i in 1 .. 30 loop
        dbms_lob.append(l_jpeg, utl_raw.copies(hextoraw('A55A'), 500));
    end loop;
    l_url := data_url('data:image/jpeg;base64,', l_jpeg);
    pruefe(dbms_lob.getlength(l_url) > 32767, 'Data-URL über 32 K (' || dbms_lob.getlength(l_url) || ' Zeichen)');
    l_bild := pck_oe_auftrag_foto_dml.bild_aus_data_url(l_url, l_mime);
    pruefe(l_mime = 'image/jpeg' and dbms_lob.compare(l_bild, l_jpeg) = 0,
           'byte-genau dekodiert: ' || dbms_lob.getlength(l_bild) || ' Bytes, ' || l_mime);

    erwarte_fehler(null, -20101, 'leerer Wert');
    erwarte_fehler(to_clob('kein Bild'), -20102, 'ohne Data-URL-Kopf');
    erwarte_fehler(data_url('data:image/gif;base64,', l_jpeg), -20102, 'nicht unterstützter Typ');
    erwarte_fehler(data_url('data:image/png;base64,', l_jpeg), -20103, 'PNG-Kopf über JPEG-Bytes');
    erwarte_fehler(to_clob('data:image/jpeg;base64,' || rpad('*', 200, '*')), -20103, 'ungültiges Base64');
    erwarte_fehler(to_clob('data:image/jpeg;base64,QUJD'), -20102, 'zu kurz');

    dbms_output.put_line('Fotos: anlegen, doppelt senden');
    insert into oe_auftrag (nr, titel) values ('SMOKE', 'Smoke-Test') returning id into l_auftrag;
    l_id1 := pck_oe_auftrag_foto_dml.anlegen(l_auftrag, l_url, 'erste Bemerkung');
    l_id2 := pck_oe_auftrag_foto_dml.anlegen(l_auftrag, l_url, 'zweite Bemerkung');
    select count(*), max(bemerkung) into l_anzahl, l_text from oe_auftrag_foto where auftrag_id = l_auftrag;
    pruefe(l_id1 = l_id2 and l_anzahl = 1, 'dasselbe Foto zweimal gesendet: eine Zeile (ID ' || l_id1 || ')');
    pruefe(l_text = 'zweite Bemerkung', 'neuere Bemerkung übernommen: ' || l_text);
    l_id2 := pck_oe_auftrag_foto_dml.anlegen(l_auftrag, l_url, null);
    select bemerkung into l_text from oe_auftrag_foto where id = l_id1;
    pruefe(l_id2 = l_id1 and l_text = 'zweite Bemerkung', 'erneut ohne Bemerkung gesendet: Bemerkung bleibt');
    dbms_lob.append(l_jpeg, hextoraw('00'));
    l_id2 := pck_oe_auftrag_foto_dml.anlegen(l_auftrag, data_url('data:image/jpeg;base64,', l_jpeg), null);
    select count(*) into l_anzahl from oe_auftrag_foto where auftrag_id = l_auftrag;
    pruefe(l_id2 <> l_id1 and l_anzahl = 2, 'anderes Foto: neue Zeile');
    select count(*) into l_anzahl from oe_auftrag_foto
     where id = l_id1 and mime_type = 'image/jpeg' and dbms_lob.compare(bild, l_bild) = 0;
    pruefe(l_anzahl = 1, 'gespeichertes Bild gleich den gesendeten Bytes');
    begin
        l_id2 := pck_oe_auftrag_foto_dml.anlegen(-1, l_url, null);
        pruefe(false, 'unbekannter Auftrag: kein Fehler');
    exception
        when others then
            pruefe(sqlcode = -20104, 'unbekannter Auftrag: ' || sqlerrm);
    end;

    rollback;
    dbms_output.put_line(case when l_fehler = 0 then 'Alle Prüfungen bestanden.'
                              else l_fehler || ' Prüfung(en) fehlgeschlagen.' end);
    if l_fehler > 0 then
        raise_application_error(-20000, 'Smoke-Test fehlgeschlagen.');
    end if;
end;
/

rollback;
exit
