import { describe, expect, test } from 'bun:test';
import { BlogApiError, unwrapBlogResponse } from '../src/services/blogApi';

const timestamp = '2026-11-23T12:00:00Z';

describe('博客接口响应', () => {
  test('解包业务数据与未绑定时的 null', () => {
    const data = { userId: 'member-1', blogTitle: 'My Blog' };
    expect(unwrapBlogResponse({ code: 0, message: 'ok', data, timestamp }, 200)).toEqual(data);
    expect(unwrapBlogResponse({ code: 0, message: 'ok', data: null, timestamp }, 200)).toBeNull();
  });

  test('保留业务提示和 HTTP 冷却状态', () => {
    const response = { code: 429, message: '请在上一次手动同步的 5 分钟后重试', data: null, timestamp };
    try {
      unwrapBlogResponse(response, 429);
      throw new Error('预期收到冷却错误');
    } catch (error) {
      expect(error).toBeInstanceOf(BlogApiError);
      expect(error).toMatchObject({ status: 429, message: response.message });
    }
  });

  test('拒绝业务失败、错误 HTTP 状态与缺失响应', () => {
    expect(() => unwrapBlogResponse({ code: 1, message: '不可用', data: null, timestamp }, 200))
      .toThrow('不可用');
    expect(() => unwrapBlogResponse({ code: 0, message: 'ok', data: [], timestamp }, 403))
      .toThrow(BlogApiError);
    expect(() => unwrapBlogResponse(undefined, 502)).toThrow(BlogApiError);
  });
});
