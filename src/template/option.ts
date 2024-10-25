export interface BareTemplateOption {
  name: string;
  value: string;
  description: string;
  tag: string[];
  author: string;
}

const templates: Array<BareTemplateOption> = [
  {
    name: 'Remix-Vite Bare Templates',
    value: 'remix-vite-template',
    description: 'A full-stack template with Remix-vite and ckb-script-templates',
    tag: ['remix', 'vite', 'tailwindcss', 'ckb-script-templates', 'typescript', 'rust'],
    author: 'retric@cryptape.com',
  },
  {
    name: 'Next.js Bare Templates',
    value: 'next-js-template',
    description: 'A full-stack template with Next.js framework and ckb-script-templates',
    tag: ['next.js', 'tailwindcss', 'ckb-script-templates', 'typescript', 'rust'],
    author: 'retric@cryptape.com',
  },
];

export function loadBareTemplateOpts(): Array<BareTemplateOption> {
  return templates;
}
