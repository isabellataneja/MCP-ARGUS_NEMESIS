create table if not exists public.in_holidays (
  id integer primary key generated always as identity,
  date date not null,
  name text not null,
  type text not null default 'general',
  notes text,
  region text not null default 'india'
    check (region in ('india', 'india-bangalore', 'india-mohali', 'india-noida'))
);

create unique index if not exists idx_in_holidays_date_unique on public.in_holidays (date);

-- Seed with major 2026 India national holidays (partial — ops will extend)
insert into public.in_holidays (date, name, type) values
  ('2026-01-01', 'New Year Day', 'general'),
  ('2026-01-26', 'Republic Day', 'public'),
  ('2026-03-04', 'Holi', 'public'),
  ('2026-04-14', 'Ambedkar Jayanti', 'public'),
  ('2026-08-15', 'Independence Day', 'public'),
  ('2026-10-02', 'Gandhi Jayanti', 'public'),
  ('2026-11-08', 'Diwali', 'public'),
  ('2026-12-25', 'Christmas', 'general')
on conflict (date) do nothing;
