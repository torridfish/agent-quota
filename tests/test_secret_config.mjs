// Regressions for the GNOME extension credential-file helpers: 
// parsing must match the Python loaders, which accept
// whitespace around assignments and let the last assignment win.

import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

function loadModule(name) {
    const source = readFileSync(
        new URL(`../gnome-shell-extension/${name}`, import.meta.url),
        'utf8',
    );
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const {readAssignment, upsertAssignment} = await loadModule('secret-config.js');



test('readAssignment accepts whitespace around key and value', () => {
    const contents = '# comment\nZAI_TOKEN =  sk-123  \nOTHER=x\n';
    assert.equal(readAssignment(contents, 'ZAI_TOKEN'), 'sk-123');
    assert.equal(readAssignment(contents, 'OTHER'), 'x');
});

test('readAssignment lets the last assignment win', () => {
    const contents = 'DEEPSEEK_API_KEY=old\n# unrelated\nDEEPSEEK_API_KEY=new\n';
    assert.equal(readAssignment(contents, 'DEEPSEEK_API_KEY'), 'new');
});

test('readAssignment ignores commented-out and substring keys', () => {
    const contents = '# GITHUB_TOKEN=nope\nNOT_GITHUB_TOKEN=x\nGITHUB_TOKEN_EXTRA=y\n';
    assert.equal(readAssignment(contents, 'GITHUB_TOKEN'), '');
});

test('upsertAssignment replaces a whitespace-formatted assignment in place', () => {
    const contents = '# header\nZAI_TOKEN = old\nWORKSPACE_ID = team1\n';
    const updated = upsertAssignment(contents, 'ZAI_TOKEN', ' sk-new ');
    assert.equal(updated, '# header\nZAI_TOKEN=sk-new\nWORKSPACE_ID = team1\n');
    assert.equal(readAssignment(updated, 'ZAI_TOKEN'), 'sk-new');
    assert.equal(readAssignment(updated, 'WORKSPACE_ID'), 'team1');
});

test('upsertAssignment collapses duplicates into a single last-winning value', () => {
    const contents = 'ZAI_TOKEN=first\n# unrelated\nZAI_TOKEN=second\n';
    const updated = upsertAssignment(contents, 'ZAI_TOKEN', 'third');
    assert.equal(updated, '# unrelated\nZAI_TOKEN=third\n');
    assert.equal(readAssignment(updated, 'ZAI_TOKEN'), 'third');
});

test('upsertAssignment appends a fresh key after existing content', () => {
    const contents = '# Managed by Agent Quota GNOME extension\nMOONSHOT_BASE_URL=https://api.moonshot.cn/v1\n';
    const updated = upsertAssignment(contents, 'MOONSHOT_API_KEY', 'sk-1');
    assert.equal(
        updated,
        '# Managed by Agent Quota GNOME extension\nMOONSHOT_BASE_URL=https://api.moonshot.cn/v1\nMOONSHOT_API_KEY=sk-1\n',
    );
});
