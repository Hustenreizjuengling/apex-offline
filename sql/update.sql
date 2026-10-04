-- Update der Beispiel-App 1.6.x -> 1.7.0, Teil 1: VOR dem Import der App (als Parsing Schema, aus dem Ordner sql/).
-- Erweitert nur. Die laufende App 1.6.x arbeitet danach unverändert weiter, deshalb gilt "Datenbank zuerst".
-- Teil 2 (update_nach_import.sql) wandelt nach dem Import die alten Fotos um und entfernt die alte Spalte.
-- Beide Teile können mehrfach laufen.
set define off
set serveroutput on
whenever sqlerror exit failure rollback

declare
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
    if spalte('BILD').column_name is null then
        execute immediate 'alter table oe_auftrag_foto add (bild blob, mime_type varchar2(30))';
        dbms_output.put_line('OE_AUFTRAG_FOTO: Spalten BILD und MIME_TYPE ergänzt.');
    end if;
    if spalte('FOTO').nullable = 'N' then
        execute immediate 'alter table oe_auftrag_foto modify (foto null)';
        dbms_output.put_line('OE_AUFTRAG_FOTO: alte Spalte FOTO ist jetzt optional.');
    end if;
    execute immediate q'[comment on column oe_auftrag_foto.bild is 'Bild (JPEG, im Browser auf höchstens 1600 Pixel verkleinert), von pck_oe_auftrag_foto_dml aus der Data-URL dekodiert']';
    execute immediate q'[comment on column oe_auftrag_foto.mime_type is 'MIME-Typ des Bildes (image/jpeg, image/png oder image/webp)']';
end;
/

@@pck_oe_auftrag_foto_dml.sql
