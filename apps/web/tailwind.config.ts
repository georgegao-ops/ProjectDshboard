import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{ts,tsx}',
    './test/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        workspace: {
          950: '#080b12',
          900: '#0f1421',
          850: '#141b2b',
          800: '#1a2437',
          700: '#23314b',
          600: '#32507b',
          accent: '#3b82f6',
          accentSoft: '#60a5fa',
        },
      },
      boxShadow: {
        panel: '0 20px 50px rgba(0, 0, 0, 0.35)',
        glow: '0 0 0 1px rgba(96, 165, 250, 0.35), 0 8px 24px rgba(37, 99, 235, 0.28)',
      },
      borderRadius: {
        panel: '16px',
      },
    },
  },
  plugins: [],
};

export default config;
