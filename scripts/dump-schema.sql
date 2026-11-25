-- The structure of the dashboard's database as one JSON document: no rows, only
-- definitions. One SELECT, so it cannot change anything. Read by
-- scripts/dump-schema.sh, proven by scripts/test-dump-schema.mjs.
select jsonb_build_object(
  'server_version', current_setting('server_version'),
  'extensions', (
    select coalesce(jsonb_agg(jsonb_build_object('name', e.extname, 'schema', n.nspname, 'version', e.extversion) order by e.extname), '[]'::jsonb)
    from pg_extension e join pg_namespace n on n.oid = e.extnamespace),
  'enums', (
    select coalesce(jsonb_agg(jsonb_build_object('name', t.typname,
             'labels', (select jsonb_agg(l.enumlabel order by l.enumsortorder) from pg_enum l where l.enumtypid = t.oid)) order by t.typname), '[]'::jsonb)
    from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typtype = 'e'),
  'tables', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'name', c.relname,
      'rls', c.relrowsecurity,
      'rls_forced', c.relforcerowsecurity,
      'comment', obj_description(c.oid, 'pg_class'),
      'columns', (
        select jsonb_agg(jsonb_build_object(
                 'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
                 'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity, 'generated', a.attgenerated,
                 'comment', col_description(c.oid, a.attnum)) order by a.attnum)
        from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
      'constraints', (
        select coalesce(jsonb_agg(jsonb_build_object('name', k.conname, 'type', k.contype, 'def', pg_get_constraintdef(k.oid)) order by k.contype, k.conname), '[]'::jsonb)
        from pg_constraint k where k.conrelid = c.oid),
      'indexes', (
        select coalesce(jsonb_agg(jsonb_build_object('name', ic.relname, 'def', pg_get_indexdef(i.indexrelid)) order by ic.relname), '[]'::jsonb)
        from pg_index i join pg_class ic on ic.oid = i.indexrelid
        where i.indrelid = c.oid and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)),
      'triggers', (
        select coalesce(jsonb_agg(jsonb_build_object('name', t.tgname, 'def', pg_get_triggerdef(t.oid)) order by t.tgname), '[]'::jsonb)
        from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal),
      'policies', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'name', p.polname, 'cmd', p.polcmd, 'permissive', p.polpermissive,
                 'roles', (select coalesce(jsonb_agg(r.rolname order by r.rolname), '["public"]'::jsonb) from pg_roles r where r.oid = any (p.polroles)),
                 'using', pg_get_expr(p.polqual, p.polrelid), 'check', pg_get_expr(p.polwithcheck, p.polrelid)) order by p.polname), '[]'::jsonb)
        from pg_policy p where p.polrelid = c.oid),
      'grants', (
        select coalesce(jsonb_agg(jsonb_build_object('role', g.grantee, 'privilege', g.privilege_type) order by g.grantee, g.privilege_type), '[]'::jsonb)
        from information_schema.role_table_grants g
        where g.table_schema = 'public' and g.table_name = c.relname and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC'))
    ) order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'views', (
    select coalesce(jsonb_agg(jsonb_build_object('name', c.relname, 'kind', c.relkind, 'options', c.reloptions, 'def', pg_get_viewdef(c.oid, true)) order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')),
  'sequences', (
    select coalesce(jsonb_agg(jsonb_build_object('name', s.sequencename, 'type', s.data_type::text, 'start', s.start_value, 'increment', s.increment_by) order by s.sequencename), '[]'::jsonb)
    from pg_sequences s where s.schemaname = 'public'),
  'functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', p.proname, 'args', pg_get_function_identity_arguments(p.oid), 'security_definer', p.prosecdef,
             'acl', p.proacl::text, 'def', pg_get_functiondef(p.oid)) order by p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind in ('f', 'p')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')),
  -- A trigger on another schema's table (auth.users, say) that calls one of our functions.
  'outside_triggers', (
    select coalesce(jsonb_agg(jsonb_build_object('table', tn.nspname || '.' || tc.relname, 'name', t.tgname, 'def', pg_get_triggerdef(t.oid)) order by tn.nspname, tc.relname, t.tgname), '[]'::jsonb)
    from pg_trigger t
      join pg_class tc on tc.oid = t.tgrelid join pg_namespace tn on tn.oid = tc.relnamespace
      join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal and tn.nspname <> 'public' and pn.nspname = 'public'),
  'publications', (
    select coalesce(jsonb_agg(jsonb_build_object('publication', pt.pubname, 'table', pt.tablename) order by pt.pubname, pt.tablename), '[]'::jsonb)
    from pg_publication_tables pt where pt.schemaname = 'public')
) as dump
