-- Azure DevOps PATs are organization-scoped and cannot call the VSSPS accounts
-- API. Store the org the operator named so Library can list repos with Code (Read).
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "azure_pat_org" text;
