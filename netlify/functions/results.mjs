import { getStore } from '@netlify/blobs';
import { api } from '../../lib/api.mjs';

export default api(() => getStore({ name: 'vic-count', consistency: 'strong' }).get('latest', { type: 'json' }));
export const config = { path: '/api/results' };
