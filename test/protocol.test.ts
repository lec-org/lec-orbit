import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOrbitProtocolUrl } from '../electron/auth/protocol';

test('合法的 lec-orbit://auth?c=... 深链解析成功', () => {
  const parsed = parseOrbitProtocolUrl('lec-orbit://auth?c=AbCdEfGh1234567890_xy');
  assert.deepEqual(parsed, {
    action: 'approve-auth',
    challengeId: 'AbCdEfGh1234567890_xy',
  });
});

test('非法协议、非法路径或过短/含特殊字符的 challengeId 一律拒绝', () => {
  assert.equal(parseOrbitProtocolUrl('https://sso.lecspace.top/auth?c=AbCdEfGh1234567890'), null);
  assert.equal(parseOrbitProtocolUrl('lec-orbit://evil?c=AbCdEfGh1234567890'), null);
  assert.equal(parseOrbitProtocolUrl('lec-orbit://auth?c=short'), null);
  assert.equal(parseOrbitProtocolUrl('lec-orbit://auth?c=invalid/slash/1234567890'), null);
});
