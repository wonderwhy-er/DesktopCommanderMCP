// sponsor-header.js - Adds a sponsor button to the header

class SponsorHeader extends HTMLElement {
  constructor() {
    super();
  }

  connectedCallback() {
    this.innerHTML = `
      <a href="#sponsors" class="header-sponsor-btn">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
        Sponsor
      </a>
    `;

    // Inject the CSS
    if (!document.getElementById('sponsor-header-style')) {
      const style = document.createElement('style');
      style.id = 'sponsor-header-style';
      style.textContent = `
        .header-sponsor-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          color: white;
          text-decoration: none;
          font-weight: 300;
          font-size: 16px;
          padding: 10px 15px;
          margin-right: 10px;
          transition: all 0.3s ease;
        }
        
        .header-sponsor-btn:hover {
          color: #0078D7;
        }
        
        @media (max-width: 768px) {
          .header-sponsor-btn {
            display: none;
          }
        }
      `;
      document.head.appendChild(style);
    }
  }
}

// Define the web component
customElements.define('sponsor-header', SponsorHeader);
