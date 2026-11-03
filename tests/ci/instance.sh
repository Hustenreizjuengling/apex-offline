#!/usr/bin/env bash
# Testinstanz für den nächtlichen Browsertest (GitHub Actions, Ubuntu-Runner): Oracle Database Free im Container,
# APEX und ORDS vom Oracle-Download, Workspace HR_DEV auf Schema HR mit den Benutzern ADMIN und TECHNIKER,
# Beispiel-App 1700 (Alias ERFASSUNG). Alle Kennwörter = CI_PW. Dauer etwa 20 Minuten, davon APEX gut 10.
#
#   CI_PW=<kennwort> tests/ci/instance.sh      -> http://localhost:8080/ords/r/hr_dev/erfassung
#
# Braucht docker, curl, unzip und Java 17+ (JAVA_HOME). Läuft auch auf einem eigenen Linux-Rechner mit Docker.
set -euo pipefail
PW=${CI_PW:?CI_PW (Kennwort für alle Benutzer der Testinstanz) setzen}
WORK=${CI_WORK:-$HOME/oracle-ci}
IMAGE=${CI_IMAGE:-gvenzl/oracle-free:latest}
PROJECT=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$WORK/logs" && cd "$WORK"
SQL="$WORK/sqlcl/bin/sql -S -L"
SYS="SYS/$PW@//localhost:1521/FREEPDB1 as sysdba"
HR="HR/$PW@//localhost:1521/FREEPDB1"
say() { echo; echo "== $(date +%H:%M:%S) $*"; }
db_ready() { echo "select 1 from dual;" | $SQL "$SYS" 2>/dev/null | grep -qE "^[[:space:]]*1[[:space:]]*$"; }

say "Downloads (APEX, ORDS, SQLcl) und Container-Image"
curl -sSfL -o apex.zip  https://download.oracle.com/otn_software/apex/apex-latest.zip &
curl -sSfL -o ords.zip  https://download.oracle.com/otn_software/java/ords/ords-latest.zip &
curl -sSfL -o sqlcl.zip https://download.oracle.com/otn_software/java/sqldeveloper/sqlcl-latest.zip &
docker pull -q "$IMAGE" >/dev/null &
wait
docker run -d --name oracle-free -p 1521:1521 -e ORACLE_PASSWORD="$PW" -e TZ=Europe/Berlin "$IMAGE" >/dev/null
unzip -q apex.zip && mkdir -p ords && unzip -q ords.zip -d ords && unzip -q sqlcl.zip
rm -f apex.zip ords.zip sqlcl.zip
echo "APEX $(cat apex/images/apex_version.txt 2>/dev/null || echo '?'), $(ords/bin/ords --version 2>/dev/null | tail -1), SQLcl $($SQL -V 2>/dev/null | tail -1)"

say "Datenbank startet"
for _ in $(seq 1 90); do db_ready && break; sleep 5; done
db_ready || { docker logs oracle-free | tail -40; echo "Datenbank nicht bereit"; exit 1; }

say "APEX installieren (etwa 10 Minuten)"
cd "$WORK/apex"
echo "@apexins.sql SYSAUX SYSAUX TEMP /i/" | $SQL "$SYS" > "$WORK/logs/apexins.log" 2>&1 || true
grep -q "Thank you for installing Oracle APEX" "$WORK/logs/apexins.log" || { tail -60 "$WORK/logs/apexins.log"; echo "APEX-Installation fehlgeschlagen"; exit 1; }
rm -rf "$WORK/apex/builder"                      # erst jetzt: apexins.sql braucht die Dateien (Meldungen, Builder); danach nur Platz
echo "@apex_rest_config_core.sql ./ $PW" | $SQL "$SYS" > "$WORK/logs/apex_rest_config.log" 2>&1 || true
$SQL "$SYS" > "$WORK/logs/workspace.log" 2>&1 <<SQLEOF
whenever sqlerror exit failure
set serveroutput on
alter user APEX_PUBLIC_USER identified by "$PW" account unlock;
begin
    apex_instance_admin.set_parameter('REQUIRE_HTTPS', 'N');           -- der Runner spricht http://localhost
    apex_instance_admin.set_parameter('STRONG_SITE_ADMIN_PASSWORD', 'N');
    apex_instance_admin.set_parameter('PASSWORD_HISTORY_DAYS', '0');
    commit;
end;
/
create user HR identified by "$PW" default tablespace users temporary tablespace temp quota unlimited on users;
grant create session, create table, create view, create sequence, create procedure, create trigger,
      create type, create synonym, create materialized view, create job to HR;
grant execute on dbms_session to HR;
begin                                                                   -- Instanz-Administrator (Workspace INTERNAL)
    apex_util.set_workspace(p_workspace => 'INTERNAL');
    apex_util.create_user(p_user_name => 'ADMIN', p_email_address => 'admin@localhost', p_web_password => '$PW',
        p_developer_privs => 'ADMIN:CREATE:DATA_LOADER:EDIT:HELP:MONITOR:SQL', p_change_password_on_first_use => 'N');
    commit;
end;
/
begin                                                                   -- Workspace HR_DEV auf HR
    apex_instance_admin.add_workspace(p_workspace => 'HR_DEV', p_primary_schema => 'HR');
    commit;
end;
/
begin                                                                   -- Entwickler und Techniker (Endanwender des Tests)
    apex_util.set_workspace(p_workspace => 'HR_DEV');
    apex_util.create_user(p_user_name => 'ADMIN', p_email_address => 'admin@localhost', p_web_password => '$PW',
        p_developer_privs => 'ADMIN:CREATE:DATA_LOADER:EDIT:HELP:MONITOR:SQL', p_change_password_on_first_use => 'N');
    apex_util.create_user(p_user_name => 'TECHNIKER', p_email_address => 'techniker@localhost', p_web_password => '$PW',
        p_change_password_on_first_use => 'N');
    commit;
end;
/
select workspace, schemas from apex_workspaces where workspace = 'HR_DEV';
exit
SQLEOF
grep -q "HR_DEV" "$WORK/logs/workspace.log" || { cat "$WORK/logs/workspace.log"; echo "Workspace fehlgeschlagen"; exit 1; }

say "ORDS installieren und starten (HTTP 8080, Bilder aus apex/images)"
ORDS="$WORK/ords/bin/ords --config $WORK/ords-config"
$ORDS install --admin-user SYS --db-hostname localhost --db-port 1521 --db-servicename FREEPDB1 \
    --feature-sdw false --feature-db-api false --feature-rest-enabled-sql false \
    --gateway-mode proxied --gateway-user APEX_PUBLIC_USER --log-folder "$WORK/logs" --password-stdin > "$WORK/logs/ords-install.log" 2>&1 <<EOF
$PW
$PW
EOF
grep -qi "completed\|abgeschlossen" "$WORK/logs/ords-install.log" || { tail -40 "$WORK/logs/ords-install.log"; echo "ORDS-Installation fehlgeschlagen"; exit 1; }
$ORDS config set standalone.static.path "$WORK/apex/images" >/dev/null
$ORDS config set standalone.http.port 8080 >/dev/null
nohup $ORDS serve > "$WORK/logs/ords.log" 2>&1 &
for _ in $(seq 1 60); do curl -s -o /dev/null http://localhost:8080/ords/ && break; sleep 3; done
curl -s -o /dev/null http://localhost:8080/ords/ || { tail -40 "$WORK/logs/ords.log"; echo "ORDS antwortet nicht"; exit 1; }

say "Beispiel-App: Tabellen, Pakete, Import"
cd "$PROJECT/sql"
echo "@install.sql" | $SQL "$HR" > "$WORK/logs/install.log" 2>&1
! grep -E "^(ORA|PLS|SP2)-" "$WORK/logs/install.log" || { cat "$WORK/logs/install.log"; echo "install.sql mit Fehlern"; exit 1; }
cd "$PROJECT"
echo "apex import -input apex_toolkit -workspace HR_DEV" | $SQL "$HR" > "$WORK/logs/import.log" 2>&1
grep -qiE "erfolgreich|success" "$WORK/logs/import.log" || { cat "$WORK/logs/import.log"; echo "Import fehlgeschlagen"; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/ords/r/hr_dev/erfassung)
say "Testinstanz bereit: http://localhost:8080/ords/r/hr_dev/erfassung (HTTP $code)"
