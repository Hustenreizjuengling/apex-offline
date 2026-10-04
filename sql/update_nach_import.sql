-- Update der Beispiel-App 1.6.x -> 1.7.0, Teil 2: NACH dem Import der App 1.7.0 (als Parsing Schema, aus sql/).
-- Wandelt Fotos, die noch als Data-URL in der alten Spalte FOTO stehen, in Bilder (BILD) um und entfernt danach
-- die alte Spalte. Schlägt eine Umwandlung fehl, bleibt FOTO zur Prüfung stehen und das Skript endet mit Fehler.
-- Der Trigger setzt UPDATED_AT/UPDATED_BY der umgewandelten Zeilen auf den Zeitpunkt der Umwandlung.
set define off
set serveroutput on
whenever sqlerror exit failure rollback

declare
    l_ids    sys.odcinumberlist;
    l_url    clob;
    l_bild   blob;
    l_mime   varchar2(30);
    l_fehler pls_integer := 0;
    l_offen  pls_integer;

    function spalte(p_name in varchar2) return user_tab_columns%rowtype is
        l_spalte user_tab_columns%rowtype;
    begin
        select * into l_spalte from user_tab_columns where table_name = 'OE_AUFTRAG_FOTO' and column_name = p_name;
        return l_spalte;
    exception
        when no_data_found then
            return l_spalte;                  -- alle Felder leer: Spalte gibt es nicht
    end spalte;
begin
    if spalte('FOTO').column_name is not null then
        -- die alte Spalte nur dynamisch lesen: das Skript muss auch laufen, wenn es sie nicht mehr gibt
        execute immediate 'select id from oe_auftrag_foto where bild is null and foto is not null order by id'
            bulk collect into l_ids;
        for i in 1 .. l_ids.count loop
            begin
                execute immediate 'select foto from oe_auftrag_foto where id = :1' into l_url using l_ids(i);
                l_bild := pck_oe_auftrag_foto_dml.bild_aus_data_url(l_url, l_mime);
                update oe_auftrag_foto set bild = l_bild, mime_type = l_mime where id = l_ids(i);
                dbms_lob.freetemporary(l_bild);
            exception
                when others then
                    l_fehler := l_fehler + 1;
                    dbms_output.put_line('Foto ' || l_ids(i) || ' nicht umgewandelt: ' || sqlerrm);
            end;
        end loop;
        commit;
        dbms_output.put_line(l_ids.count - l_fehler || ' Foto(s) umgewandelt.');
        select count(*) into l_offen from oe_auftrag_foto where bild is null;
        if l_fehler > 0 or l_offen > 0 then
            raise_application_error(-20100, l_offen || ' Foto(s) ohne Bild - die alte Spalte FOTO bleibt zur Prüfung stehen.');
        end if;
        execute immediate 'alter table oe_auftrag_foto drop column foto';
        dbms_output.put_line('OE_AUFTRAG_FOTO: alte Spalte FOTO entfernt.');
    end if;
    if spalte('BILD').nullable = 'Y' then
        execute immediate 'alter table oe_auftrag_foto modify (bild not null, mime_type not null)';
    end if;
    for r in (select 1 from dual
               where not exists (select 1 from user_constraints
                                  where table_name = 'OE_AUFTRAG_FOTO' and constraint_name = 'OE_AUFTRAG_FOTO_MIME_CK')) loop
        execute immediate q'[alter table oe_auftrag_foto add constraint oe_auftrag_foto_mime_ck
                             check (mime_type in ('image/jpeg', 'image/png', 'image/webp'))]';
    end loop;
    execute immediate q'[comment on table oe_auftrag_foto is 'Fotos zu Aufträgen, offline aufgenommen und über die native Formularseite 4 gespeichert']';
end;
/

@@pck_oe_html.sql
