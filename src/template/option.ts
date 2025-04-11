export interface BareTemplateOption {
  name: string;
  value: string;
  description: string;
  tag: string[];
  author: string;
}

const templates: Array<BareTemplateOption> = [
  {
    name: 'JS Script with Next.js fullstack template',
    value: 'js-script-next-js',
    description: 'A full-stack template with Next-js and ckb-js-vm script',
    tag: ['next.js', 'tailwindcss', 'ckb-js-vm', 'typescript'],
    author: 'retric@cryptape.com',
  },
  {
    name: 'Rust Script with Remix-Vite fullstack template',
    value: 'remix-vite-template',
    description: 'A full-stack template with Remix-vite and ckb-script-templates',
    tag: ['remix', 'vite', 'tailwindcss', 'ckb-script-templates', 'typescript', 'rust'],
    author: 'retric@cryptape.com',
  },
  {
    name: 'Rust Script with Next.js fullstack template',
    value: 'next-js-template',
    description: 'A full-stack template with Next.js framework and ckb-script-templates',
    tag: ['next.js', 'tailwindcss', 'ckb-script-templates', 'typescript', 'rust'],
    author: 'retric@cryptape.com',
  },
];

export function loadBareTemplateOpts(): Array<BareTemplateOption> {
  return templates;
}
