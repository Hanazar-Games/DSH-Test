import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const CODE_LENGTH = 7;

// 62^7 ≈ 3.5e12 codes; 7 chars keeps short links short and collisions negligible.
export function randomCode(length = CODE_LENGTH) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}
