-- One-shot probe to expose project JWT settings to service-role only.
create or replace function public.__probe_pg_settings()
returns jsonb
language plpgsql
security definer
as $$
declare
  result jsonb := '{}'::jsonb;
  setting_name text;
begin
  -- Try every well-known Supabase JWT secret setting name.
  for setting_name in select unnest(array[
    'app.settings.jwt_secret',
    'pgrst.jwt_secret',
    'pgrst.app_settings.jwt_secret',
    'app.jwt_secret',
    'request.jwt.claim.secret',
    'app.settings.jwt_exp',
    'pgrst.db_anon_role'
  ]) loop
    begin
      result := result || jsonb_build_object(setting_name, current_setting(setting_name, true));
    exception when others then
      result := result || jsonb_build_object(setting_name, '<error: ' || sqlerrm || '>');
    end;
  end loop;
  return result;
end;
$$;
revoke all on function public.__probe_pg_settings() from anon, authenticated;
