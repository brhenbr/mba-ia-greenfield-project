import { generatePublicId } from './public-id.util';
import { PUBLIC_ID_LENGTH, PUBLIC_ID_PATTERN } from './videos.constants';

describe('generatePublicId', () => {
  it('should produce 11 characters from the URL-safe alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const id = generatePublicId();

      expect(id).toHaveLength(PUBLIC_ID_LENGTH);
      expect(id).toMatch(PUBLIC_ID_PATTERN);
    }
  });

  it('should not repeat across a large sample', () => {
    const ids = new Set(Array.from({ length: 20000 }, generatePublicId));

    expect(ids.size).toBe(20000);
  });

  it('should use every symbol of the alphabet over a large sample', () => {
    const seen = new Set(
      Array.from({ length: 2000 }, generatePublicId).join('').split(''),
    );

    expect(seen.size).toBe(64);
  });
});
