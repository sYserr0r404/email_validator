import { test } from 'node:test';
import assert from 'node:assert';
import { validateSyntax, isRoleAccount } from '../lib/syntax.js';

test('validates correct email syntax', () => {
  const result = validateSyntax('user@example.com');
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.local, 'user');
  assert.strictEqual(result.domain, 'example.com');
});

test('rejects email without @', () => {
  const result = validateSyntax('userexample.com');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /@ sign/);
});

test('rejects email with multiple @', () => {
  const result = validateSyntax('user@@example.com');
  assert.strictEqual(result.valid, false);
});

test('rejects empty local part', () => {
  const result = validateSyntax('@example.com');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /local part/i);
});

test('rejects empty domain', () => {
  const result = validateSyntax('user@');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /domain/i);
});

test('rejects domain without dot', () => {
  const result = validateSyntax('user@example');
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /dot/);
});

test('enforces local part length limit (64)', () => {
  const longLocal = 'a'.repeat(65) + '@example.com';
  const result = validateSyntax(longLocal);
  assert.strictEqual(result.valid, false);
  assert.match(result.reason, /64/);
});

test('enforces total length limit (254)', () => {
  const longEmail = 'a'.repeat(250) + '@example.com';
  const result = validateSyntax(longEmail);
  assert.strictEqual(result.valid, false);
});

test('handles IDN domains (punycode)', () => {
  const result = validateSyntax('user@münchen.de');
  assert.strictEqual(result.valid, true);
  assert.match(result.domain, /xn--/);
});

test('identifies role accounts', () => {
  assert.strictEqual(isRoleAccount('admin'), true);
  assert.strictEqual(isRoleAccount('postmaster'), true);
  assert.strictEqual(isRoleAccount('noreply'), true);
  assert.strictEqual(isRoleAccount('user'), false);
});
