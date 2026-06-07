alter table public.operational_ai_models
  drop constraint if exists operational_ai_models_provider_check;

alter table public.operational_ai_models
  add constraint operational_ai_models_provider_check
  check (provider in ('gemini', 'openai-compatible', 'deepseek'));
