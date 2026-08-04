// pm2 process definition. PORT, BASE_URL and the secrets come from .env, which
// src/server.js loads through dotenv — they are deliberately not repeated here.
module.exports = {
  apps: [
    {
      name: 'readmeify',
      script: 'src/server.js',
      cwd: '/home/ubuntu/projects/readmeify',
      // node:sqlite is still flagged experimental on Node 22 and prints a warning
      // on every boot. The API it uses is stable; silence just that category.
      node_args: ['--disable-warning=ExperimentalWarning'],
      env: { NODE_ENV: 'production' },
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
