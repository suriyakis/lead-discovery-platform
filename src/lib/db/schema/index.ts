// Single import surface for the database schema. The Drizzle client and
// drizzle-kit both read from here. Add new tables by exporting them from
// their module file and re-exporting that module here.

export * from './auth';
export * from './workspaces';
export * from './audit';
export * from './products';
export * from './connectors';
export * from './review';
export * from './learning';
export * from './secrets';
export * from './qualifications';
export * from './outreach';
export * from './documents';
export * from './mailing';
export * from './pipeline';
export * from './rag';
export * from './crm';
export * from './admin';
export * from './contacts';
export * from './autopilot';
