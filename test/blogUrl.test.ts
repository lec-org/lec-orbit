import { describe, expect, test } from 'bun:test';
import { parseBlogUrl } from '../src/shared/blogUrl';

describe('成员博客地址', () => {
  test('接受绝对 HTTP(S) 地址并规范化主机', () => {
    expect(parseBlogUrl(' HTTPS://Example.com/posts/one#notes ')?.href)
      .toBe('https://example.com/posts/one#notes');
    expect(parseBlogUrl('http://example.com:8080/')?.origin).toBe('http://example.com:8080');
  });

  test.each([
    '/article', '//example.com', 'https:example.com', 'https://',
    'file:///blog.html', 'data:text/html,blog', 'javascript:void(0)', 'lec-orbit://blog',
    'https://user:password@example.com',
  ])('拒绝不允许的目标 %s', (value) => {
    expect(parseBlogUrl(value)).toBeNull();
  });
});
