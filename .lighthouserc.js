
module.exports = {
  ci: {
    collect: {
      url: ['http://localhost:3000'],
      startServerCommand: 'npm run build:web && npx http-server ./dist -p 3000',
      numberOfRuns: 1
    },
    assert: {
      assertions: {
        'categories:performance': ['error', {minScore: 0.75}],
        'categories:accessibility': ['error', {minScore: 0.9}],
        'categories:best-practices': ['error', {minScore: 0.9}],
        'categories:seo': ['warn', {minScore: 0.5}]
      }
    },
    upload: {
      target: 'temporary-public-storage'
    }
  }
};
