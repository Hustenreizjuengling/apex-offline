-- Anzeige der Unterschrift (Data-URL) im Protokoll - nur für die Beispiel-App.
-- Fotos liegen als Bild (BLOB) vor und werden nativ angezeigt (Seite 3, Spalte "Display Image").
create or replace package pck_oe_html as

    -- <img> für eine Data-URL; null, wenn der Wert kein Bild im erwarteten Format ist
    function bild(p_data_url in clob, p_alt in varchar2, p_style in varchar2 default null) return clob;

    -- CLOB stückweise ausgeben (für Items "Display Only - Output of PL/SQL Code")
    procedure drucken(p_html in clob);

end pck_oe_html;
/

create or replace package body pck_oe_html as

    function bild(p_data_url in clob, p_alt in varchar2, p_style in varchar2 default null) return clob is
        l_html clob;
    begin
        -- nur echte Base64-Bilder: dann enthält der Wert keine Zeichen, die HTML verändern könnten
        if p_data_url is null
           or not regexp_like(p_data_url, '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$') then
            return null;
        end if;
        l_html := to_clob('<img alt="' || apex_escape.html_attribute(p_alt) || '" style="'
                          || apex_escape.html_attribute(p_style) || '" src="');
        dbms_lob.append(l_html, p_data_url);
        dbms_lob.append(l_html, to_clob('">'));
        return l_html;
    end bild;

    procedure drucken(p_html in clob) is
        l_len pls_integer;
    begin
        if p_html is null then
            return;
        end if;
        l_len := dbms_lob.getlength(p_html);
        for i in 0 .. trunc((l_len - 1) / 8000) loop
            htp.prn(dbms_lob.substr(p_html, 8000, i * 8000 + 1));
        end loop;
    end drucken;

end pck_oe_html;
/
