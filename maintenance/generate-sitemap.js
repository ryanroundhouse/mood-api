const SitemapGenerator = require('sitemap-generator');

// Create a generator object
const generator = SitemapGenerator('http://localhost:3000', {
  stripQuerystring: false,
  filepath: './sitemap.xml',
});

// Register event listeners
generator.on('done', () => {
  console.log('Sitemap generated');
});

// Start the crawler
generator.start();
