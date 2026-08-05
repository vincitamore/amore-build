/** Bun text imports for embedded schema files (required for bun build --compile). */
declare module "*.sql" {
  const content: string;
  export default content;
}
