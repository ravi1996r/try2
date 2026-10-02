/**
 * Validates content/profile.json against content/profile.schema.json with Ajv.
 * Run: node scripts/validate-content.mjs
 *
 * WHY: the profile drives the entire site and Chatbot 1's retrieval, so an invalid profile must
 * fail loudly at build time rather than render a half-empty portfolio.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(readFileSync(join(ROOT, 'content/profile.schema.json'), 'utf8'));
const profile = JSON.parse(readFileSync(join(ROOT, 'content/profile.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

if (!validate(profile)) {
  console.error('profile.json FAILED schema validation:');
  for (const e of validate.errors ?? []) {
    console.error(`  ${e.instancePath || '/'} ${e.message} (${e.keyword})`);
  }
  process.exit(1);
}
console.log('profile.json is schema-valid');
console.log(`  sections: ${profile.sections.length}, skills groups: ${profile.skills.length}, `
  + `employers: ${profile.experience.length}, certifications: ${profile.certifications.length}, `
  + `source pointers: ${profile.source_register.length}`);