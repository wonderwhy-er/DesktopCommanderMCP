// Mobile Menu Toggle
const mobileMenuBtn = document.querySelector('.mobile-menu-btn');
const nav = document.querySelector('nav');

mobileMenuBtn.addEventListener('click', () => {
    nav.classList.toggle('active');
});

// Smooth Scrolling
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            window.scrollTo({
                top: target.offsetTop - 80,
                behavior: 'smooth'
            });
        }
        
        // Close mobile menu if open
        if (nav.classList.contains('active')) {
            nav.classList.remove('active');
        }
    });
});

// FAQ Accordion
const accordionHeaders = document.querySelectorAll('.accordion-header');

accordionHeaders.forEach(header => {
    header.addEventListener('click', () => {
        const accordionItem = header.parentElement;
        accordionItem.classList.toggle('active');
    });
});

// Sticky Header
window.addEventListener('scroll', () => {
    const header = document.querySelector('header');
    header.classList.toggle('sticky', window.scrollY > 0);
});

// Initialize first FAQ item as open
document.querySelector('.accordion-item')?.classList.add('active');

// Tab functionality
function openTab(evt, tabName) {
    // Hide all tab content
    const tabContent = document.getElementsByClassName("tab-content");
    for (let i = 0; i < tabContent.length; i++) {
        tabContent[i].classList.remove("active");
    }
    
    // Remove active class from all tab buttons
    const tabBtns = document.getElementsByClassName("tab-btn");
    for (let i = 0; i < tabBtns.length; i++) {
        tabBtns[i].classList.remove("active");
    }
    
    // Show the current tab and add active class to the button
    document.getElementById(tabName).classList.add("active");
    evt.currentTarget.classList.add("active");
}

// Initialize any elements that require it
document.addEventListener('DOMContentLoaded', () => {
    // Initialize first FAQ item as open if it exists
    const firstAccordionItem = document.querySelector('.accordion-item');
    if (firstAccordionItem) {
        firstAccordionItem.classList.add('active');
    }
    
    // Expose the openTab function globally if it's used inline
    window.openTab = openTab;
    
    // Initialize testimonial carousel
    initTestimonialCarousel();
    
});

// Testimonial Carousel Implementation
function initTestimonialCarousel() {
    const carousel = document.querySelector('.testimonial-carousel');
    if (!carousel) return;
    
    const slides = document.querySelectorAll('.carousel-slide');
    const prevBtn = document.getElementById('prevSlide');
    const nextBtn = document.getElementById('nextSlide');
    const indicators = document.querySelectorAll('.indicator');
    
    if (!slides.length || !prevBtn || !nextBtn) return;
    
    let currentSlide = 0;
    const totalSlides = slides.length;
    
    // Preload all images to get their dimensions and reduce jumping
    function preloadImages() {
        const allImages = [];
        let maxHeight = 0;
        let loadedCount = 0;
        
        slides.forEach(slide => {
            const img = slide.querySelector('img');
            if (!img) return;
            
            // Check if already loaded or load it
            if (img.complete) {
                const height = img.offsetHeight;
                maxHeight = Math.max(maxHeight, height);
                loadedCount++;
                
                // If all images loaded, set the container height
                if (loadedCount === slides.length) {
                    setInitialContainerHeight(maxHeight);
                }
            } else {
                img.addEventListener('load', () => {
                    const height = img.offsetHeight;
                    maxHeight = Math.max(maxHeight, height);
                    loadedCount++;
                    
                    // If all images loaded, set the container height
                    if (loadedCount === slides.length) {
                        setInitialContainerHeight(maxHeight);
                    }
                });
            }
            
            allImages.push(img);
        });
        
        // If no images or all already loaded, set container height
        if (allImages.length === 0 || loadedCount === slides.length) {
            setInitialContainerHeight(maxHeight);
        }
    }
    
    // Set initial container height to the tallest slide
    function setInitialContainerHeight(height) {
        if (height === 0) height = 300; // Default minimum height
        const slidesContainer = document.querySelector('.carousel-slides');
        slidesContainer.style.height = height + 'px';
        
        // Now we can start properly transitioning between slides
        slidesContainer.classList.add('height-initialized');
    }
    
    // Update height when changing slides (smoother than initial setup)
    function updateCarouselHeight() {
        const activeSlide = document.querySelector('.carousel-slide.active');
        if (!activeSlide) return;
        
        const img = activeSlide.querySelector('img');
        if (!img || !img.complete) return;
        
        // Add a small padding to avoid cutting off bottom of image
        const height = img.offsetHeight + 20;
        const slidesContainer = document.querySelector('.carousel-slides');
        
        // Only update if necessary and if significant difference
        const currentHeight = parseInt(slidesContainer.style.height);
        if (Math.abs(currentHeight - height) > 10) {
            slidesContainer.style.height = height + 'px';
        }
    }
    
    // Show a specific slide
    function showSlide(index) {
        if (index < 0) index = totalSlides - 1;
        if (index >= totalSlides) index = 0;
        
        // Update slides
        slides.forEach((slide, i) => {
            slide.classList.toggle('active', i === index);
        });
        
        // Update indicators
        indicators.forEach((indicator, i) => {
            indicator.classList.toggle('active', i === index);
        });
        
        currentSlide = index;
        updateCarouselHeight();
    }
    
    // Event listeners for navigation
    prevBtn.addEventListener('click', () => {
        showSlide(currentSlide - 1);
    });
    
    nextBtn.addEventListener('click', () => {
        showSlide(currentSlide + 1);
    });
    
    // Indicator clicks
    indicators.forEach((indicator, index) => {
        indicator.addEventListener('click', () => {
            showSlide(index);
        });
    });
    
    // Preload images to reduce jumping
    preloadImages();
    
    // Initialize with the first slide
    showSlide(0);
    
    // Handle window resize
    window.addEventListener('resize', updateCarouselHeight);
    
    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft') {
            showSlide(currentSlide - 1);
        } else if (e.key === 'ArrowRight') {
            showSlide(currentSlide + 1);
        }
    });
    
    // Touch swipe support for mobile
    let touchStartX = 0;
    let touchEndX = 0;
    
    const handleSwipe = () => {
        const diff = touchStartX - touchEndX;
        if (Math.abs(diff) > 50) { // Threshold to detect a swipe
            if (diff > 0) {
                // Swipe left, show next slide
                showSlide(currentSlide + 1);
            } else {
                // Swipe right, show previous slide
                showSlide(currentSlide - 1);
            }
        }
    };
    
    carousel.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
    });
    
    carousel.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        handleSwipe();
    });
}
