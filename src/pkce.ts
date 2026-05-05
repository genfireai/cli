import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = randomBytes(64).toString('base64url').slice(0, 96);
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge, codeChallengeMethod: 'S256' };
}
