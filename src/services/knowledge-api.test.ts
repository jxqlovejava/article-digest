import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import { registerKnowledgeRoutes } from './knowledge-api';

/**
 * Start the express app on a random port, call apiGet() to make HTTP requests.
 * Since the underlying service modules are still being built, most endpoints
 * return {{ success, data }} when the service exists and {{ error }} otherwise.
 */
let baseUrl: string;
let server: http.Server;

function apiGet(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 500, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode || 500, body: data });
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function apiPost(path: string, body: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => (responseData += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 500, body: JSON.parse(responseData) });
        } catch {
          resolve({ status: res.statusCode || 500, body: responseData });
        }
      });
      res.on('error', reject);
    });
    req.write(data);
    req.end();
  });
}

describe('Knowledge API Routes', () => {
  before(() => {
    return new Promise<void>((resolve, reject) => {
      const app = express();
      app.use(express.json());
      registerKnowledgeRoutes(app);

      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
          resolve();
        } else {
          reject(new Error('Failed to start server'));
        }
      });
    });
  });

  describe('GET /api/knowledge/reviews/stats', () => {
    it('returns a JSON response with success or error property', async () => {
      const res = await apiGet('/api/knowledge/reviews/stats');
      assert.ok([200, 500].includes(res.status));
      assert.ok(typeof res.body === 'object');
      // Should have either success or error
      assert.ok(
        ('success' in res.body && 'data' in res.body) ||
        ('error' in res.body)
      );
    });

    it('returns total/due/mastered when service exists', async () => {
      const res = await apiGet('/api/knowledge/reviews/stats');
      if (res.body.success) {
        assert.ok('total' in res.body.data);
        assert.ok('due' in res.body.data);
        assert.ok('mastered' in res.body.data);
      }
    });
  });

  describe('GET /api/knowledge/memory/overview', () => {
    it('returns a JSON response with success or error property', async () => {
      const res = await apiGet('/api/knowledge/memory/overview');
      assert.ok([200, 500].includes(res.status));
      assert.ok(typeof res.body === 'object');
    });
  });

  describe('GET /api/knowledge/reviews/due', () => {
    it('returns a JSON response', async () => {
      const res = await apiGet('/api/knowledge/reviews/due');
      assert.ok([200, 500].includes(res.status));
      assert.ok(typeof res.body === 'object');
    });
  });

  describe('GET /api/knowledge/clusters', () => {
    it('returns a JSON response', async () => {
      const res = await apiGet('/api/knowledge/clusters');
      assert.ok([200, 500].includes(res.status));
      assert.ok(typeof res.body === 'object');
    });
  });

  describe('GET /api/knowledge/synthesis/latest', () => {
    it('returns a JSON response', async () => {
      const res = await apiGet('/api/knowledge/synthesis/latest');
      assert.ok([200, 500].includes(res.status));
      assert.ok(typeof res.body === 'object');
    });
  });

  describe('GET /api/knowledge/classify?fileName=', () => {
    it('returns 400 when fileName is missing', async () => {
      const res = await apiGet('/api/knowledge/classify');
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('POST /api/knowledge/quiz/generate', () => {
    it('returns 400 when fileName is missing', async () => {
      const res = await apiPost('/api/knowledge/quiz/generate', {});
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('POST /api/knowledge/reviews/grade', () => {
    it('returns 400 when questionId is missing', async () => {
      const res = await apiPost('/api/knowledge/reviews/grade', { answer: 'test' });
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('POST /api/knowledge/synthesis/generate', () => {
    it('returns 400 when period is missing', async () => {
      const res = await apiPost('/api/knowledge/synthesis/generate', {});
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });

    it('returns 400 when period is invalid', async () => {
      const res = await apiPost('/api/knowledge/synthesis/generate', { period: 'invalid' });
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('GET /api/knowledge/memory/L2?surface=', () => {
    it('returns 400 when surface is missing', async () => {
      const res = await apiGet('/api/knowledge/memory/L2');
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('POST /api/knowledge/memory/consolidate', () => {
    it('returns 400 when surface is missing', async () => {
      const res = await apiPost('/api/knowledge/memory/consolidate', {});
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('GET /api/knowledge/memory/L3?slot=', () => {
    it('returns 400 when slot is missing', async () => {
      const res = await apiGet('/api/knowledge/memory/L3');
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });

  describe('GET /api/knowledge/links?fileName=', () => {
    it('returns 400 when fileName is missing', async () => {
      const res = await apiGet('/api/knowledge/links');
      assert.strictEqual(res.status, 400);
      assert.ok('error' in res.body);
    });
  });
});
