import { getStore } from '@netlify/blobs';
import { api } from '../../lib/api.mjs';

const store = () => getStore({ name: 'vic-count', consistency: 'strong' });
export default api(() => store().get('latest', { type: 'json' }), {
  readBooths: id => store().get(`booths/${id}`, {type:'json'}),
  saveBooths: (id, detail) => store().setJSON(`booths/${id}`,detail),
});
export const config = { path: '/api/results' };
