const forms = require('@tailwindcss/forms');
const containerQueries = require('@tailwindcss/container-queries');

module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{vue,js,ts,html}'],
  theme: {
    extend: {
      colors: {
        'tertiary-fixed':'#ffdad4','on-tertiary-container':'#ffece8','background':'#f8f9ff','inverse-primary':'#b4c5ff','on-primary-container':'#eeefff','surface-tint':'#0053db','surface-container-highest':'#d3e4fe','inverse-surface':'#213145','on-primary':'#ffffff','surface':'#f8f9ff','error':'#ba1a1a','on-primary-fixed-variant':'#003ea8','error-container':'#ffdad6','on-primary-fixed':'#00174b','on-error':'#ffffff','on-tertiary':'#ffffff','surface-bright':'#f8f9ff','surface-container-low':'#eff4ff','on-surface':'#0b1c30','primary-container':'#2563eb','tertiary-container':'#b84936','outline-variant':'#c3c6d7','secondary-fixed-dim':'#6bd8cb','secondary-fixed':'#89f5e7','surface-container-high':'#dce9ff','tertiary':'#983121','primary-fixed-dim':'#b4c5ff','secondary-container':'#86f2e4','surface-dim':'#cbdbf5','on-tertiary-fixed':'#3f0300','on-secondary-fixed':'#00201d','on-background':'#0b1c30','secondary':'#006a61','surface-container-lowest':'#ffffff','on-surface-variant':'#434655','on-tertiary-fixed-variant':'#842415','primary-fixed':'#dbe1ff','inverse-on-surface':'#eaf1ff','on-secondary-fixed-variant':'#005049','surface-container':'#e5eeff','on-error-container':'#93000a','tertiary-fixed-dim':'#ffb4a6','outline':'#737686','primary':'#004ac6','on-secondary-container':'#006f66','on-secondary':'#ffffff','surface-variant':'#d3e4fe',
      },
      borderRadius: { DEFAULT:'0.25rem', lg:'0.5rem', xl:'0.75rem', full:'9999px' },
      spacing: { xs:'4px', sm:'8px', base:'4px', md:'16px', lg:'24px', xl:'32px', xxl:'48px', gutter:'24px', 'container-max':'1280px' },
      maxWidth: { 'container-max':'1280px' },
      fontFamily: {
        'body-md':['Inter'], 'body-lg':['Inter'], 'body-sm':['Inter'], 'label-md':['Inter'], 'label-sm':['Inter'],
        'display-lg':['Plus Jakarta Sans'], 'headline-lg':['Plus Jakarta Sans'], 'headline-md':['Plus Jakarta Sans'], 'headline-sm':['Plus Jakarta Sans'],
      },
      fontSize: {
        'body-md':['16px',{lineHeight:'1.6',fontWeight:'400'}],
        'body-lg':['18px',{lineHeight:'1.6',fontWeight:'400'}],
        'body-sm':['14px',{lineHeight:'1.5',fontWeight:'400'}],
        'display-lg':['48px',{lineHeight:'1.2',letterSpacing:'-0.02em',fontWeight:'700'}],
        'headline-lg':['32px',{lineHeight:'1.3',fontWeight:'700'}],
        'headline-md':['24px',{lineHeight:'1.4',fontWeight:'600'}],
        'headline-sm':['20px',{lineHeight:'1.4',fontWeight:'600'}],
        'label-md':['14px',{lineHeight:'1.2',letterSpacing:'0.05em',fontWeight:'600'}],
        'label-sm':['12px',{lineHeight:'1.2',fontWeight:'500'}],
      },
    },
  },
  plugins: [forms, containerQueries],
};
