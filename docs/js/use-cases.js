// Use Cases Page JavaScript

class UseCaseLibrary {
    constructor() {
        this.useCases = [];
        this.filteredCases = [];
        this.currentFilter = 'all';
        this.currentSort = 'votes';
        this.userVotes = this.loadUserVotes();
        
        this.init();
    }
    
    async init() {
        await this.loadUseCases();
        this.bindEvents();
        this.renderUseCases();
        this.hideLoading();
    }
    
    async loadUseCases() {
        // For now, using hardcoded data. Later can be moved to JSON file
        this.useCases = [
            {
                id: 'explore-repository',
                title: 'Explore and Understand New Repository',
                category: 'developer',
                difficulty: 'simple',
                description: 'Get a complete architectural overview of any codebase instantly. Perfect for onboarding to new projects or understanding complex repositories.',
                ahaMessage: 'DC reads my entire codebase and gives me a complete architectural overview instantly',
                prompt: 'I need to understand this codebase: [repo path]. Give me an overview of the project structure, main components, and how they interact. Identify the entry points and key files I should focus on first.',
                votes: 47,
                dateAdded: '2025-08-10'
            },
            {
                id: 'build-feature',
                title: 'Build Complete Feature from Scratch',
                category: 'developer',
                difficulty: 'medium',
                description: 'Implement entire features with real code written directly to your files. Like having a developer who can actually code, not just suggest.',
                ahaMessage: 'DC writes real code directly to my files - like having a developer who can actually implement',
                prompt: 'I need to build [feature description] in my project at [project path]. Create all necessary files, implement the feature, and integrate it with existing code.',
                votes: 35,
                dateAdded: '2025-08-09'
            },
            {
                id: 'organize-downloads',
                title: 'Organize Downloads Folder',
                category: 'automation',
                difficulty: 'simple',
                description: 'The perfect first use case! Automatically sort your messy Downloads folder into organized subfolders by file type.',
                ahaMessage: 'DC accesses my files and moves them around automatically',
                prompt: 'Analyze my Downloads folder and organize all files into subfolders by type (Documents, Images, Videos, Archives, etc.).',
                votes: 52,
                dateAdded: '2025-08-11'
            },
            {
                id: 'analyze-data-file',
                title: 'Analyze My Data File',
                category: 'data',
                difficulty: 'simple',
                description: 'Upload any CSV, Excel, or data file and get instant analysis with insights, patterns, and visualizations. No Excel skills required.',
                ahaMessage: 'I don\'t need Excel skills - it finds my file and does analysis for me',
                prompt: 'Look for the file called \'[filename]\' in my [folder]. Analyze this file and tell me: what data it contains, key patterns or insights, and create visualizations if helpful.',
                votes: 29,
                dateAdded: '2025-08-08'
            },
            {
                id: 'setup-dev-environment',
                title: 'Set Up Development Environment',
                category: 'developer',
                difficulty: 'medium',
                description: 'Automate the painful process of environment setup. Install dependencies, configure tools, and get coding immediately.',
                ahaMessage: 'DC handles all environment setup automatically',
                prompt: 'Set up a complete development environment for [technology stack] on my machine. Install dependencies, configure tools, and verify everything works.',
                votes: 31,
                dateAdded: '2025-08-07'
            }
        ];
        
        // Apply initial filter and sort
        this.applyFilter();
        this.applySorting();
    }
    
    bindEvents() {
        // Filter buttons
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.setFilter(e.target.dataset.filter);
            });
        });
        
        // Sort dropdown
        document.getElementById('sort-select').addEventListener('change', (e) => {
            this.setSort(e.target.value);
        });
    }
    
    setFilter(filter) {
        this.currentFilter = filter;
        
        // Update button states
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.filter === filter);
        });
        
        this.applyFilter();
        this.applySorting();
        this.renderUseCases();
    }
    
    setSort(sort) {
        this.currentSort = sort;
        this.applySorting();
        this.renderUseCases();
    }
    
    applyFilter() {
        if (this.currentFilter === 'all') {
            this.filteredCases = [...this.useCases];
        } else {
            this.filteredCases = this.useCases.filter(useCase => 
                useCase.category === this.currentFilter
            );
        }
    }
    
    applySorting() {
        this.filteredCases.sort((a, b) => {
            switch (this.currentSort) {
                case 'votes':
                    return b.votes - a.votes;
                case 'recent':
                    return new Date(b.dateAdded) - new Date(a.dateAdded);
                case 'difficulty':
                    const difficultyOrder = { 'simple': 1, 'medium': 2, 'advanced': 3 };
                    return difficultyOrder[a.difficulty] - difficultyOrder[b.difficulty];
                default:
                    return 0;
            }
        });
    }
    
    renderUseCases() {
        const container = document.getElementById('use-cases-container');
        const emptyState = document.getElementById('empty-state');
        
        if (this.filteredCases.length === 0) {
            container.innerHTML = '';
            emptyState.style.display = 'block';
            return;
        }
        
        emptyState.style.display = 'none';
        container.innerHTML = this.filteredCases.map(useCase => 
            this.renderUseCaseCard(useCase)
        ).join('');
        
        // Bind event listeners to new elements
        this.bindCardEvents();
    }
    
    renderUseCaseCard(useCase) {
        const userVote = this.userVotes[useCase.id] || 0;
        const displayVotes = useCase.votes + userVote;
        
        return `
            <div class="use-case-card" data-category="${useCase.category}" data-difficulty="${useCase.difficulty}">
                <div class="card-header">
                    <h3 class="card-title">${useCase.title}</h3>
                    <span class="difficulty-badge difficulty-${useCase.difficulty}">
                        ${useCase.difficulty}
                    </span>
                </div>
                
                <div class="card-category">${this.getCategoryLabel(useCase.category)}</div>
                
                <p class="card-description">${useCase.description}</p>
                
                <div class="aha-moment">
                    <div class="aha-label">💡 Aha Moment:</div>
                    <p class="aha-text">"${useCase.ahaMessage}"</p>
                </div>
                
                <div class="prompt-section">
                    <div class="prompt-label">
                        📝 Ready-to-Use Prompt:
                    </div>
                    <div class="prompt-text">${useCase.prompt}</div>
                </div>
                
                <div class="card-actions">
                    <button class="copy-btn" data-prompt="${this.escapeHtml(useCase.prompt)}" data-id="${useCase.id}">
                        📋 Copy Prompt
                    </button>
                    
                    <div class="voting-section">
                        <button class="vote-btn vote-up ${userVote > 0 ? 'voted' : ''}" 
                                data-id="${useCase.id}" data-vote="1">
                            👍
                        </button>
                        <span class="vote-count">${displayVotes}</span>
                        <button class="vote-btn vote-down ${userVote < 0 ? 'voted' : ''}" 
                                data-id="${useCase.id}" data-vote="-1">
                            👎
                        </button>
                    </div>
                </div>
            </div>
        `;
    }
    
    bindCardEvents() {
        // Copy button events
        document.querySelectorAll('.copy-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.copyPrompt(e.target);
            });
        });
        
        // Vote button events
        document.querySelectorAll('.vote-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.handleVote(e.target);
            });
        });
    }
    
    async copyPrompt(button) {
        const prompt = button.dataset.prompt;
        const useCaseId = button.dataset.id;
        
        try {
            await navigator.clipboard.writeText(prompt);
            
            // Visual feedback
            const originalText = button.innerHTML;
            button.innerHTML = '✅ Copied!';
            button.classList.add('copied');
            
            setTimeout(() => {
                button.innerHTML = originalText;
                button.classList.remove('copied');
            }, 2000);
            
            // Track analytics
            this.trackEvent('prompt_copied', { use_case_id: useCaseId });
            
        } catch (err) {
            // Fallback for older browsers
            this.fallbackCopyTextToClipboard(prompt, button);
        }
    }
    
    fallbackCopyTextToClipboard(text, button) {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.top = "0";
        textArea.style.left = "0";
        textArea.style.position = "fixed";
        
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        try {
            document.execCommand('copy');
            button.innerHTML = '✅ Copied!';
            button.classList.add('copied');
            
            setTimeout(() => {
                button.innerHTML = '📋 Copy Prompt';
                button.classList.remove('copied');
            }, 2000);
            
        } catch (err) {
            button.innerHTML = '❌ Copy Failed';
            setTimeout(() => {
                button.innerHTML = '📋 Copy Prompt';
            }, 2000);
        }
        
        document.body.removeChild(textArea);
    }
    
    handleVote(button) {
        const useCaseId = button.dataset.id;
        const voteValue = parseInt(button.dataset.vote);
        const currentVote = this.userVotes[useCaseId] || 0;
        
        // Toggle vote or switch between up/down
        let newVote;
        if (currentVote === voteValue) {
            newVote = 0; // Remove vote if clicking same button
        } else {
            newVote = voteValue; // Set new vote
        }
        
        // Update user votes
        this.userVotes[useCaseId] = newVote;
        this.saveUserVotes();
        
        // Re-render to update vote counts and button states
        this.renderUseCases();
        
        // Track analytics
        this.trackEvent('vote_changed', { 
            use_case_id: useCaseId, 
            vote_value: newVote 
        });
    }
    
    loadUserVotes() {
        try {
            const votes = localStorage.getItem('dc_use_case_votes');
            return votes ? JSON.parse(votes) : {};
        } catch (e) {
            return {};
        }
    }
    
    saveUserVotes() {
        try {
            localStorage.setItem('dc_use_case_votes', JSON.stringify(this.userVotes));
        } catch (e) {
            console.warn('Could not save votes to localStorage');
        }
    }
    
    getCategoryLabel(category) {
        const labels = {
            'beginner': 'Beginner Friendly',
            'developer': 'For Developers',
            'data': 'Data Analysis',
            'automation': 'Automation'
        };
        return labels[category] || category;
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    hideLoading() {
        document.getElementById('loading-state').style.display = 'none';
    }
    
    trackEvent(eventName, properties = {}) {
        // Simple analytics tracking - can be enhanced later
        if (typeof gtag !== 'undefined') {
            gtag('event', eventName, properties);
        }
        
        // Console log for debugging
        console.log('Event tracked:', eventName, properties);
    }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    // Load header and footer (assuming these are shared components)
    loadSharedComponents();
    
    // Initialize use case library
    new UseCaseLibrary();
});

// Function to load shared header/footer
async function loadSharedComponents() {
    try {
        // Load header (simplified version for now)
        const header = document.getElementById('header-placeholder');
        if (header) {
            header.innerHTML = `
                <nav style="background: #171717; padding: 1rem 0; position: fixed; top: 0; left: 0; right: 0; z-index: 1000;">
                    <div style="max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 0 2rem;">
                        <a href="/" style="color: white; text-decoration: none; font-weight: bold; font-size: 1.25rem;">
                            Desktop Commander
                        </a>
                        <div style="display: flex; gap: 2rem;">
                            <a href="/" style="color: #a0a0a0; text-decoration: none;">Home</a>
                            <a href="/use-cases.html" style="color: white; text-decoration: none;">Use Cases</a>
                            <a href="https://github.com/wonderwhy-er/DesktopCommanderMCP" style="color: #a0a0a0; text-decoration: none;">GitHub</a>
                        </div>
                    </div>
                </nav>
            `;
        }
        
        // Load footer (simplified version for now)
        const footer = document.getElementById('footer-placeholder');
        if (footer) {
            footer.innerHTML = `
                <div style="background: #171717; color: white; padding: 2rem 0; text-align: center;">
                    <p style="margin: 0; color: #a0a0a0;">&copy; 2025 Desktop Commander MCP. Open source and free forever.</p>
                </div>
            `;
        }
    } catch (e) {
        console.warn('Could not load shared components:', e);
    }
}