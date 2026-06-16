-- Row-level region on holiday tables (MCP Region string = holidays.region), for get_regional_holidays / leave heuristics.

ALTER TABLE IF EXISTS public.bd_holidays
  ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT 'AX-BD-Dhaka';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'in_holidays'
  ) THEN
    ALTER TABLE public.in_holidays DROP CONSTRAINT IF EXISTS in_holidays_region_check;

    DROP INDEX IF EXISTS public.idx_in_holidays_date_unique;

    UPDATE public.in_holidays SET region = 'AX-IN-Bangalore'
    WHERE region IN ('india', 'india-bangalore', 'india-mohali', 'india-noida')
       OR region IS NULL;

    ALTER TABLE public.in_holidays ALTER COLUMN region SET DEFAULT 'AX-IN-Bangalore';

    CREATE UNIQUE INDEX IF NOT EXISTS idx_in_holidays_date_region ON public.in_holidays (date, region);

    INSERT INTO public.in_holidays (date, name, type, region)
    SELECT i.date, i.name, i.type, v.r
    FROM public.in_holidays i
    CROSS JOIN (VALUES ('IN-IDS-Mohali'::text), ('IN-IDS-Noida'::text)) AS v(r)
    WHERE i.region = 'AX-IN-Bangalore'
      AND NOT EXISTS (SELECT 1 FROM public.in_holidays x WHERE x.date = i.date AND x.region = v.r);
  END IF;
END $$;
