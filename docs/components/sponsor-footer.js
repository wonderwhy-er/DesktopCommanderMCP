// sponsor-footer.js - Adds a sponsor column to the footer

class SponsorFooter extends HTMLElement {
  constructor() {
    super();
  }

  connectedCallback() {
    this.innerHTML = `
      <div class="footer-column">
        <h3>Sponsor Us</h3>
        <ul class="sponsor-links">
          <li><a href="https://github.com/sponsors/wonderwhy-er" target="_blank">GitHub Sponsors</a></li>
          <li><a href="https://patreon.com/EduardsRuzga" target="_blank">Patreon</a></li>
          <li><a href="https://ko-fi.com/eduardsruzga" target="_blank">Ko-fi</a></li>
          <li><a href="https://www.buymeacoffee.com/wonderwhyer" target="_blank">Buy Me A Coffee</a></li>
          <li><a href="https://thanks.dev/u/gh/wonderwhy-er" target="_blank">thanks.dev</a></li>
        </ul>
      </div>
    `;

    // Inject the CSS
    if (!document.getElementById('sponsor-footer-style')) {
      const style = document.createElement('style');
      style.id = 'sponsor-footer-style';
      style.textContent = `
        .sponsor-links li {
          margin-bottom: 10px;
        }
        
        .sponsor-links li a {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .sponsor-links li a:hover {
          color: #0078D7;
        }
      `;
      document.head.appendChild(style);
    }
  }
}

// Define the web component
customElements.define('sponsor-footer', SponsorFooter);
