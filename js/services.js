/*
 * MRI Personal Workspace — service entry point.
 * Importing this module registers every route, opens the local database and
 * exposes the small surface the UI needs.
 */
import * as DB from './db.js';
import './svc_recruitment.js';
import './svc_knowledge.js';
import './svc_employees.js';
import './svc_system.js';
import { api, isFileResult, HttpError } from './core.js';

export { api, isFileResult, HttpError, DB };

/** Opens the database. Call once at startup. */
export async function openWorkspace(dbName) {
  await DB.open(dbName);
}

/** Runs an export/download endpoint and returns {blob, filename}. */
export async function apiFile(path) {
  const res = await api(path);
  if (!isFileResult(res)) throw new HttpError(500, 'Respons bukan file.');
  return res;
}
