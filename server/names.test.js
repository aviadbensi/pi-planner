/*
 * Tests for the unique project-name logic (server/names.js).
 * Run from the server folder:  node --test
 *
 * This guards the dedupe rules used when creating, duplicating, or renaming a
 * board so two boards can never share a name.
 */
const test = require('node:test');
const assert = require('node:assert');
const { makeUniqueName } = require('./names');

test('returns the name unchanged when nothing collides', () => {
  assert.equal(makeUniqueName('Alpha', []), 'Alpha');
  assert.equal(makeUniqueName('Alpha', ['Beta', 'Gamma']), 'Alpha');
});

test('appends (2) on a first collision, then (3), (4)…', () => {
  assert.equal(makeUniqueName('Alpha', ['Alpha']), 'Alpha (2)');
  assert.equal(makeUniqueName('Alpha', ['Alpha', 'Alpha (2)']), 'Alpha (3)');
  assert.equal(makeUniqueName('Alpha', ['Alpha', 'Alpha (2)', 'Alpha (3)']), 'Alpha (4)');
});

test('counts up from an existing numbered suffix instead of nesting', () => {
  // Renaming "Alpha (2)" into a set that already has it must give (3), not "Alpha (2) (2)".
  assert.equal(makeUniqueName('Alpha (2)', ['Alpha (2)']), 'Alpha (3)');
  assert.equal(makeUniqueName('Alpha (2)', ['Alpha (2)', 'Alpha (3)']), 'Alpha (4)');
});

test('collision check is case-insensitive and trimmed', () => {
  assert.equal(makeUniqueName('alpha', ['ALPHA']), 'alpha (2)');
  assert.equal(makeUniqueName('  Alpha  ', ['Alpha']), 'Alpha (2)');
  assert.equal(makeUniqueName('Alpha', ['  alpha  ']), 'Alpha (2)');
});

test('(copy) names dedupe by adding a number after the copy suffix', () => {
  // Mirrors duplicating the same board twice.
  assert.equal(makeUniqueName('Alpha (copy)', ['Alpha (copy)']), 'Alpha (copy) (2)');
  assert.equal(
    makeUniqueName('Alpha (copy)', ['Alpha (copy)', 'Alpha (copy) (2)']),
    'Alpha (copy) (3)'
  );
});

test('blank / whitespace / nullish names fall back to "Untitled"', () => {
  assert.equal(makeUniqueName('', []), 'Untitled');
  assert.equal(makeUniqueName('   ', []), 'Untitled');
  assert.equal(makeUniqueName(null, []), 'Untitled');
  assert.equal(makeUniqueName(undefined, []), 'Untitled');
  assert.equal(makeUniqueName('', ['Untitled']), 'Untitled (2)');
});

test('ignores nullish entries inside the taken list', () => {
  assert.equal(makeUniqueName('Alpha', [null, undefined, 'Alpha']), 'Alpha (2)');
});
