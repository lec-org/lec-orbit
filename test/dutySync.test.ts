import { expect, test } from 'bun:test';
import { dutyRefreshFailure, editableDutyVersion, DutyVersionError, OrbitHttpError, parseDutyResponse } from '../src/services/dutySync';

const saved = { anchor: '2026-11-23', groups: [['甲']] };

test('只有有效的周一起点及成员列表可进入页面缓存', () => {
  expect(parseDutyResponse(saved)).toEqual(saved);
  for (const invalid of [{}, { ...saved, groups: ['甲'] }, { ...saved, anchor: '2026-11-24' }, { ...saved, anchor: null }]) {
    expect(() => parseDutyResponse(invalid)).toThrow();
  }
});

test('同一份已加载的名单在断网时保留，在认证失效或权限撤销时清除', () => {
  for (const status of [undefined, 503]) expect(dutyRefreshFailure(saved, new OrbitHttpError('', status)).schedule).toBe(saved);
  expect(dutyRefreshFailure(saved, new OrbitHttpError('', 401))).toEqual({ schedule: null, message: '登录已失效，请重新登录' });
  expect(dutyRefreshFailure(saved, new OrbitHttpError('', 403))).toEqual({ schedule: null, message: '当前账号无权查看值日安排' });
});

test('缺失版本的旧服务端即使返回空排班也不能编辑', () => {
  expect(() => editableDutyVersion({ anchor: null, groups: [] })).toThrow(DutyVersionError);
  expect(() => editableDutyVersion({ ...saved, version: null })).toThrow(DutyVersionError);
  expect(editableDutyVersion({ anchor: null, groups: [], version: null })).toBeNull();
  expect(editableDutyVersion({ ...saved, version: '123' })).toBe('123');
});
