// sponsors-section.js - Sponsors section web component

class SponsorsSection extends HTMLElement {
  constructor() {
    super();
  }

  connectedCallback() {
    this.innerHTML = `
      <section class="sponsors-section" id="sponsors">
        <div class="container">
          <div class="section-title">
            <h2>Our Sponsors</h2>
            <p>Desktop Commander MCP is free and open source, but it requires time to improve it. Our philosophy is that we do not want you to pay for it if you are not successful. But if you are successful and Desktop Commander contributes to your success, consider contributing to ours.</p>
          </div>
          
          <div class="sponsors-grid">
            <div class="sponsor-card">
              <a href="https://github.com/jonrichards" target="_blank" rel="noopener noreferrer">
                <img src="https://github.com/jonrichards.png" alt="Jon Richards" class="sponsor-avatar">
                <div class="sponsor-info">
                  <h3>Jon Richards</h3>
                  <span class="sponsor-username">@jonrichards</span>
                </div>
              </a>
            </div>
            <div class="sponsor-card">
              <a href="https://github.com/stepanic" target="_blank" rel="noopener noreferrer">
                <img src="https://github.com/stepanic.png" alt="Goran Stepanic" class="sponsor-avatar">
                <div class="sponsor-info">
                  <h3>Goran Stepanic</h3>
                  <span class="sponsor-username">@stepanic</span>
                </div>
              </a>
            </div>
          </div>
          
          <div class="sponsor-cta">
            <p>If your contributions are generous, you'll be added to the sponsors list and can request to add a link/message to go along with your mention.</p>
            <div class="sponsor-buttons">
              <a href="https://github.com/sponsors/wonderwhy-er" target="_blank" rel="noopener noreferrer" class="btn primary-btn sponsor-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>
                Sponsor on GitHub
              </a>
              <!--<a href="https://patreon.com/EduardsRuzga" target="_blank" rel="noopener noreferrer" class="btn secondary-btn sponsor-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v6"></path><path d="M5 7.3l14 14"></path><circle cx="12" cy="17" r="3"></circle><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
                Sponsor on Patreon
              </a>-->
              <a href="https://ko-fi.com/eduardsruzga" target="_blank" rel="noopener noreferrer" class="btn secondary-btn sponsor-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.85 0 0 1 2.83 2.83v.34a2.85 2.85 0 0 1-2.83 2.83H7a2.85 2.85 0 0 1-2.83-2.83v-.34A2.85 2.85 0 0 1 7 3h10ZM7 21a2.85 2.85 0 0 1-2.83-2.83v-.34A2.85 2.85 0 0 1 7 15h10a2.85 2.85 0 0 1 2.83 2.83v.34A2.85 2.85 0 0 1 17 21H7Z"></path><path d="M18 15v-2a2.85 2.85 0 0 0-2.83-2.83H8.83A2.85 2.85 0 0 0 6 13v2"></path><circle cx="12" cy="8" r="2"></circle></svg>
                Support on Ko-fi
              </a>
              <a href="https://www.buymeacoffee.com/wonderwhyer" target="_blank" rel="noopener noreferrer" class="btn secondary-btn sponsor-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 11h1a3 3 0 0 1 0 6h-1"></path><path d="M9 11h6a3 3 0 0 1 0 6H9a3 3 0 0 1 0-6Z"></path><path d="M3 11v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8"></path><path d="M10.3 7.7 11 4h2l.7 3.7a1.91 1.91 0 0 1-.5 1.7L12 11l-1.2-1.6a1.91 1.91 0 0 1-.5-1.7Z"></path><path d="M8 21v-2"></path><path d="M16 21v-2"></path></svg>
                Buy Me a Coffee
              </a>
              <a href="https://thanks.dev/u/gh/wonderwhy-er" target="_blank" rel="noopener noreferrer" class="btn secondary-btn sponsor-btn">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"></path></svg>
                Support via thanks.dev
              </a>
            </div>
          </div>
        </div>
      </section>
    `;

    // Inject the CSS
    if (!document.getElementById('sponsors-section-style')) {
      const style = document.createElement('style');
      style.id = 'sponsors-section-style';
      style.textContent = `
        .sponsors-section {
          background-color: #f8f9fa;
          padding: 80px 0;
        }
        
        .sponsors-grid {
          display: flex;
          justify-content: center;
          gap: 40px;
          margin-top: 50px;
          flex-wrap: wrap;
        }
        
        .sponsor-card {
          background-color: #ffffff;
          border-radius: 12px;
          box-shadow: 0 5px 15px rgba(0, 0, 0, 0.05);
          padding: 30px;
          transition: all 0.3s ease;
          width: 250px;
          text-align: center;
        }
        
        .sponsor-card:hover {
          transform: translateY(-5px);
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
        }
        
        .sponsor-avatar {
          width: 120px;
          height: 120px;
          border-radius: 50%;
          margin-bottom: 20px;
          border: 3px solid #0078D7;
        }
        
        .sponsor-info h3 {
          margin-bottom: 5px;
          color: #171717;
          font-weight: 300;
        }
        
        .sponsor-username {
          color: #666;
          font-size: 0.9rem;
        }
        
        .sponsor-cta {
          text-align: center;
          margin-top: 50px;
        }
        
        .sponsor-cta p {
          max-width: 800px;
          margin: 0 auto 30px;
          color: #555;
          font-weight: 300;
        }
        
        .sponsor-buttons {
          display: flex;
          justify-content: center;
          gap: 15px;
          flex-wrap: wrap;
        }
        
        .sponsor-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 20px;
          border-radius: 6px;
          text-decoration: none;
          font-weight: 300;
          transition: all 0.3s ease;
        }
        
        .primary-btn.sponsor-btn {
          background-color: #0078D7;
          color: white;
        }
        
        .primary-btn.sponsor-btn:hover {
          background-color: #0056a0;
          color: white;
        }
        
        .secondary-btn.sponsor-btn {
          background-color: transparent;
          border: 1px solid #0078D7;
          color: #0078D7;
        }
        
        .secondary-btn.sponsor-btn:hover {
          background-color: rgba(0, 120, 215, 0.1);
          color: #0078D7;
        }
        
        @media (max-width: 768px) {
          .sponsors-grid {
            gap: 20px;
          }
          
          .sponsor-card {
            width: 100%;
            max-width: 250px;
          }
          
          .sponsor-buttons {
            flex-direction: column;
            align-items: center;
            gap: 10px;
          }
          
          .sponsor-btn {
            width: 100%;
            max-width: 250px;
            justify-content: center;
          }
        }
      `;
      document.head.appendChild(style);
    }
  }
}

// Define the web component
customElements.define('sponsors-section', SponsorsSection);
