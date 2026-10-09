import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const contractTemplateKeys = ['mensualidad', 'paquete', 'rutinas'] as const;
export type ContractTemplateKey = typeof contractTemplateKeys[number];
export const CONTRACT_TERMINATION_NOTICE_DAYS = 5;

const templateNames: Record<ContractTemplateKey, string> = {
  mensualidad: 'mensualidad.txt', paquete: 'paquete.txt', rutinas: 'rutinas.txt'
};

function templatePath(name: string) {
  return fileURLToPath(new URL('contract-templates/' + name, import.meta.url));
}

export function normalizeContractName(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es-PA');
}

export function readContractTemplate(key: ContractTemplateKey) {
  return readFileSync(templatePath(templateNames[key]), 'utf8');
}

export function renderContractTemplate(key: ContractTemplateKey, values: Record<string, unknown>) {
  const source = readContractTemplate(key);
  const body = source.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, marker: string) => values[marker] == null ? match : String(values[marker]));
  const unresolved = body.match(/\{\{[^}]+\}\}/g) || [];
  if (unresolved.length) throw new Error(`La plantilla tiene marcadores sin resolver: ${unresolved.join(', ')}`);
  return body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function contractTemplateVersion(key: ContractTemplateKey) {
  const version = Number(readFileSync(templatePath(`${key}.version`), 'utf8').trim());
  if (!Number.isInteger(version) || version < 1) throw new Error('La versión de la plantilla no es válida');
  return version;
}

export function contractTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Panama', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type: string) => parts.find(part => part.type === type)?.value || '';
  return `${value('day')}-${value('month')}-${value('year')} ${value('hour')}:${value('minute')}`;
}
