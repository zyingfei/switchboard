import { randomBytes } from 'node:crypto';
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const randomBase32 = (length) => {
    const bytes = randomBytes(length);
    let output = '';
    for (const byte of bytes) {
        output += alphabet.charAt(byte % alphabet.length);
    }
    return output;
};
export const createBacId = () => randomBase32(16);
export const createDispatchId = () => `disp_${randomBase32(20)}`;
export const createReviewId = () => `rev_${randomBase32(20)}`;
export const createRevision = () => randomBase32(20);
export const createRequestId = () => `req_${randomBase32(20)}`;
//# sourceMappingURL=ids.js.map