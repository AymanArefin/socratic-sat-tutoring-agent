#!/usr/bin/env python3
"""
SAT Suite Question Bank API Investigation Script

This script navigates to the SAT Suite Question Bank, monitors network traffic,
and captures API endpoints used to fetch questions.

Requirements:
    pip install selenium selenium-wire pillow
    
You'll also need Chrome/Chromium browser installed.
"""

import json
import time
from datetime import datetime
from seleniumwire import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options
from selenium.common.exceptions import TimeoutException, NoSuchElementException

def setup_driver():
    """Setup Chrome driver with network interception"""
    chrome_options = Options()
    # chrome_options.add_argument('--headless')  # Uncomment to run headless
    chrome_options.add_argument('--no-sandbox')
    chrome_options.add_argument('--disable-dev-shm-usage')
    chrome_options.add_argument('--window-size=1920,1080')
    
    # Enable network interception
    seleniumwire_options = {
        'disable_encoding': True  # Disable encoding to see raw responses
    }
    
    driver = webdriver.Chrome(options=chrome_options, seleniumwire_options=seleniumwire_options)
    return driver

def capture_api_calls(driver, output_file='api_calls.json'):
    """Capture and analyze API calls"""
    api_calls = []
    
    for request in driver.requests:
        if request.response:
            # Look for JSON responses (likely API endpoints)
            content_type = request.response.headers.get('Content-Type', '')
            
            if 'json' in content_type or 'api' in request.url.lower():
                try:
                    response_body = request.response.body.decode('utf-8')
                    
                    # Try to parse as JSON
                    try:
                        json_response = json.loads(response_body)
                    except:
                        json_response = None
                    
                    api_call = {
                        'url': request.url,
                        'method': request.method,
                        'status_code': request.response.status_code,
                        'request_headers': dict(request.headers),
                        'response_headers': dict(request.response.headers),
                        'request_body': request.body.decode('utf-8') if request.body else None,
                        'response_body': json_response if json_response else response_body[:1000],
                        'timestamp': datetime.now().isoformat()
                    }
                    
                    api_calls.append(api_call)
                    
                    print(f"\n{'='*80}")
                    print(f"API Call Found: {request.method} {request.url}")
                    print(f"Status: {request.response.status_code}")
                    print(f"Content-Type: {content_type}")
                    if json_response:
                        print(f"Response Preview: {json.dumps(json_response, indent=2)[:500]}...")
                    print(f"{'='*80}\n")
                    
                except Exception as e:
                    print(f"Error processing request {request.url}: {e}")
    
    # Save to file
    with open(output_file, 'w') as f:
        json.dump(api_calls, f, indent=2)
    
    print(f"\n✓ Saved {len(api_calls)} API calls to {output_file}")
    return api_calls

def investigate_page(driver):
    """Navigate and interact with the page to trigger API calls"""
    url = "https://satsuiteeducatorquestionbank.collegeboard.org/digital/search"
    
    print(f"Navigating to {url}...")
    driver.get(url)
    
    # Take initial screenshot
    driver.save_screenshot('sat_page_initial.png')
    print("✓ Initial screenshot saved: sat_page_initial.png")
    
    # Wait for page to load
    time.sleep(5)
    
    print("\nWaiting for content to load...")
    try:
        # Wait for any interactive elements
        WebDriverWait(driver, 10).until(
            EC.presence_of_element_located((By.TAG_NAME, "body"))
        )
    except TimeoutException:
        print("⚠ Timeout waiting for page elements")
    
    # Take screenshot after load
    driver.save_screenshot('sat_page_loaded.png')
    print("✓ Loaded screenshot saved: sat_page_loaded.png")
    
    # Try to find and interact with filters
    print("\nLooking for filter elements...")
    
    # Common selectors for filters
    filter_selectors = [
        "select[name*='domain']",
        "select[name*='difficulty']",
        "button[aria-label*='filter']",
        "div[class*='filter']",
        "input[type='checkbox']",
        "select",
        "button[role='button']"
    ]
    
    for selector in filter_selectors:
        try:
            elements = driver.find_elements(By.CSS_SELECTOR, selector)
            if elements:
                print(f"  Found {len(elements)} elements matching: {selector}")
                # Try clicking/interacting with first element
                try:
                    elements[0].click()
                    time.sleep(2)
                    print(f"  ✓ Clicked element: {selector}")
                    driver.save_screenshot(f'sat_page_after_{selector.replace("[", "_").replace("]", "_")}.png')
                except Exception as e:
                    print(f"  ⚠ Could not interact with {selector}: {e}")
        except Exception as e:
            pass
    
    # Scroll down to trigger lazy loading
    print("\nScrolling page to trigger lazy loading...")
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
    time.sleep(3)
    driver.save_screenshot('sat_page_scrolled.png')
    
    # Get page source for analysis
    with open('sat_page_source.html', 'w', encoding='utf-8') as f:
        f.write(driver.page_source)
    print("✓ Page source saved: sat_page_source.html")
    
    # Look for JavaScript files
    print("\nExtracting JavaScript file URLs...")
    scripts = driver.find_elements(By.TAG_NAME, "script")
    js_files = []
    for script in scripts:
        src = script.get_attribute('src')
        if src:
            js_files.append(src)
            print(f"  - {src}")
    
    with open('js_files.txt', 'w') as f:
        f.write('\n'.join(js_files))
    print("✓ JavaScript files saved: js_files.txt")

def analyze_results(api_calls):
    """Analyze and summarize the captured API calls"""
    print("\n" + "="*80)
    print("ANALYSIS SUMMARY")
    print("="*80)
    
    if not api_calls:
        print("\n⚠ No API calls captured. The page might require authentication or use WebSockets.")
        return
    
    # Group by domain
    domains = {}
    for call in api_calls:
        from urllib.parse import urlparse
        domain = urlparse(call['url']).netloc
        if domain not in domains:
            domains[domain] = []
        domains[domain].append(call)
    
    print(f"\n📊 Total API calls captured: {len(api_calls)}")
    print(f"📊 Unique domains: {len(domains)}")
    
    for domain, calls in domains.items():
        print(f"\n🌐 Domain: {domain}")
        print(f"   Calls: {len(calls)}")
        
        for call in calls[:3]:  # Show first 3 calls per domain
            print(f"\n   📍 {call['method']} {call['url']}")
            print(f"      Status: {call['status_code']}")
            
            # Show query parameters
            from urllib.parse import urlparse, parse_qs
            parsed = urlparse(call['url'])
            if parsed.query:
                params = parse_qs(parsed.query)
                print(f"      Query Params: {json.dumps(params, indent=8)}")
            
            # Show auth headers
            auth_headers = {k: v for k, v in call['request_headers'].items() 
                          if 'auth' in k.lower() or 'token' in k.lower() or 'key' in k.lower()}
            if auth_headers:
                print(f"      Auth Headers: {json.dumps(auth_headers, indent=8)}")

def main():
    """Main execution"""
    print("="*80)
    print("SAT Suite Question Bank API Investigation")
    print("="*80)
    
    driver = None
    try:
        driver = setup_driver()
        investigate_page(driver)
        
        # Wait a bit more for any delayed requests
        print("\nWaiting for additional network activity...")
        time.sleep(5)
        
        # Capture all API calls
        api_calls = capture_api_calls(driver)
        
        # Analyze results
        analyze_results(api_calls)
        
        print("\n" + "="*80)
        print("Investigation complete! Check the following files:")
        print("  - api_calls.json (detailed API call data)")
        print("  - sat_page_*.png (screenshots)")
        print("  - sat_page_source.html (page HTML)")
        print("  - js_files.txt (JavaScript file URLs)")
        print("="*80)
        
    except Exception as e:
        print(f"\n❌ Error: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        if driver:
            print("\nClosing browser...")
            driver.quit()

if __name__ == "__main__":
    main()
