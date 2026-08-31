-- The annual KPI write wrapper is SECURITY DEFINER and owned by postgres.
-- Keep its protected table under the same owner so the wrapper can write
-- without granting direct table access to the public API roles.

alter table reporting.annual_passenger_kpis owner to postgres;

revoke all on reporting.annual_passenger_kpis
from public, anon, authenticated, service_role;
