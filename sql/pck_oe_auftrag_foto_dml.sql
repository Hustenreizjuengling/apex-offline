-- DML-Paket für OE_AUFTRAG_FOTO (Beispiel-App). Ein Foto kommt als Data-URL aus einem Item mit der CSS-Klasse
-- offline-photo und wird als echtes Bild (BLOB) gespeichert. Kein COMMIT: die Transaktion gehört dem Aufrufer.
create or replace package pck_oe_auftrag_foto_dml as

    -- 'data:image/jpeg|png|webp;base64,...' -> Bild und MIME-Typ. Fehler mit lesbarem Text:
    -- ORA-20101 kein Foto, ORA-20102 kein unterstütztes Bild, ORA-20103 beschädigt.
    function bild_aus_data_url(p_data_url in clob, p_mime_type out varchar2) return blob;

    -- Foto an einen Auftrag hängen, liefert die ID. Dieselben Bytes am selben Auftrag werden nur einmal
    -- gespeichert: ein erneut gesendeter Offline-Entwurf ist ein Erfolg mit der vorhandenen Zeile, eine neuere
    -- Bemerkung wird übernommen. ORA-20104 Auftrag gibt es nicht, ORA-20105 Auftrag gerade gesperrt.
    function anlegen(p_auftrag_id in number, p_data_url in clob, p_bemerkung in varchar2) return number;

end pck_oe_auftrag_foto_dml;
/

create or replace package body pck_oe_auftrag_foto_dml as

    e_gesperrt exception;
    pragma exception_init(e_gesperrt, -30006);    -- Sperre nicht innerhalb von WAIT erhalten

    procedure freigeben(p_lob in out nocopy clob) is
    begin
        if p_lob is not null and dbms_lob.istemporary(p_lob) = 1 then
            dbms_lob.freetemporary(p_lob);
        end if;
    end freigeben;

    procedure freigeben(p_lob in out nocopy blob) is
    begin
        if p_lob is not null and dbms_lob.istemporary(p_lob) = 1 then
            dbms_lob.freetemporary(p_lob);
        end if;
    end freigeben;

    function bild_aus_data_url(p_data_url in clob, p_mime_type out varchar2) return blob is
        l_laenge integer;
        l_komma  integer;
        l_base64 clob;
        l_bild   blob;
        l_magic  raw(12);
        l_ok     boolean;
    begin
        p_mime_type := null;
        if p_data_url is null then
            raise_application_error(-20101, 'Kein Foto.');
        end if;
        l_laenge := dbms_lob.getlength(p_data_url);
        l_komma  := dbms_lob.instr(p_data_url, ',', 1, 1);
        if l_komma is null or l_komma < 20 or l_komma > 30 or l_laenge - l_komma < 16 then
            raise_application_error(-20102, 'Das Foto ist keine gültige Bilddatei.');
        end if;
        p_mime_type := case dbms_lob.substr(p_data_url, l_komma, 1)
                           when 'data:image/jpeg;base64,' then 'image/jpeg'
                           when 'data:image/png;base64,'  then 'image/png'
                           when 'data:image/webp;base64,' then 'image/webp'
                       end;
        if p_mime_type is null then
            raise_application_error(-20102, 'Das Foto ist kein JPEG-, PNG- oder WebP-Bild.');
        end if;
        begin
            -- Kopf abschneiden: mit Kopf liefert der Decoder ohne Fehler falsche Bytes
            dbms_lob.createtemporary(l_base64, true, dbms_lob.call);
            dbms_lob.copy(l_base64, p_data_url, l_laenge - l_komma, 1, l_komma + 1);
            l_bild := apex_web_service.clobbase642blob(l_base64);
            freigeben(l_base64);
        exception
            when value_error then             -- ungültiges Base64
                freigeben(l_base64);
                freigeben(l_bild);
                raise_application_error(-20103, 'Das Foto ist beschädigt.');
        end;
        if l_bild is null or dbms_lob.getlength(l_bild) < 12 then
            freigeben(l_bild);
            raise_application_error(-20103, 'Das Foto ist beschädigt.');
        end if;
        l_magic := dbms_lob.substr(l_bild, 12, 1);
        l_ok := case p_mime_type
                    when 'image/jpeg' then utl_raw.substr(l_magic, 1, 3) = hextoraw('FFD8FF')
                    when 'image/png'  then utl_raw.substr(l_magic, 1, 4) = hextoraw('89504E47')
                    when 'image/webp' then utl_raw.substr(l_magic, 1, 4) = hextoraw('52494646')
                                       and utl_raw.substr(l_magic, 9, 4) = utl_raw.cast_to_raw('WEBP')
                end;
        if l_ok is null or not l_ok then
            freigeben(l_bild);
            raise_application_error(-20103, 'Das Foto ist beschädigt.');
        end if;
        return l_bild;
    end bild_aus_data_url;

    function anlegen(p_auftrag_id in number, p_data_url in clob, p_bemerkung in varchar2) return number is
        l_mime    oe_auftrag_foto.mime_type%type;
        l_bild    blob;
        l_id      oe_auftrag_foto.id%type;
        l_auftrag oe_auftrag.id%type;
    begin
        l_bild := bild_aus_data_url(p_data_url, l_mime);
        begin
            -- Auftrag sperren: zwei Übertragungen desselben Fotos laufen nacheinander, die zweite sieht die erste
            select id into l_auftrag from oe_auftrag where id = p_auftrag_id for update wait 10;
        exception
            when no_data_found then
                raise_application_error(-20104, 'Den Auftrag gibt es nicht mehr.');
            when e_gesperrt then
                raise_application_error(-20105, 'Der Auftrag wird gerade bearbeitet. Bitte erneut speichern.');
        end;
        select min(id) into l_id
          from oe_auftrag_foto
         where auftrag_id = p_auftrag_id
           and dbms_lob.getlength(bild) = dbms_lob.getlength(l_bild)
           and dbms_lob.compare(bild, l_bild) = 0;
        if l_id is null then
            insert into oe_auftrag_foto (auftrag_id, bild, mime_type, bemerkung)
            values (p_auftrag_id, l_bild, l_mime, p_bemerkung)
            returning id into l_id;
        elsif p_bemerkung is not null then    -- schon gespeichert: neuere Bemerkung übernehmen
            update oe_auftrag_foto
               set bemerkung = p_bemerkung
             where id = l_id
               and (bemerkung is null or bemerkung <> p_bemerkung);
        end if;
        freigeben(l_bild);
        return l_id;
    exception
        when others then
            freigeben(l_bild);
            raise;
    end anlegen;

end pck_oe_auftrag_foto_dml;
/
