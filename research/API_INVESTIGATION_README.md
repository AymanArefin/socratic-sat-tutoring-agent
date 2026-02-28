# SAT Suite Question Bank API Investigation

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements_investigation.txt
```

You'll also need Chrome browser installed on your system.

### 2. Run the Investigation Script

```bash
python investigate_sat_api.py
```

The script will:
- Navigate to the SAT Suite Question Bank search page
- Take screenshots at various stages
- Monitor all network traffic
- Capture API calls (especially JSON responses)
- Try to interact with filters to trigger API calls
- Save all data to files for analysis

### 3. Review the Output

After running, check these files:

- **api_calls.json** - Complete details of all API calls including:
  - Endpoint URLs
  - Request/response headers
  - Query parameters
  - Request/response bodies
  - Authentication tokens

- **sat_page_*.png** - Screenshots showing:
  - Initial page load
  - After interactions
  - After scrolling

- **sat_page_source.html** - Full HTML source for manual inspection

- **js_files.txt** - List of JavaScript files (you can inspect these for hardcoded API endpoints)

## What to Look For

### In api_calls.json:

1. **Question Fetch Endpoints**
   - Look for URLs containing: `question`, `search`, `query`, `items`
   - Check the response body for question data structure

2. **Query Parameters**
   - `domain` - Subject domain (Math, Reading, etc.)
   - `difficulty` - Question difficulty level
   - `limit`, `offset` - Pagination
   - `filters` - Any filter parameters

3. **Authentication**
   - Check `request_headers` for:
     - `Authorization` header
     - `X-API-Key` or similar
     - Session cookies
     - CSRF tokens

4. **Response Structure**
   - Question ID
   - Question text
   - Answer choices
   - Correct answer
   - Metadata (difficulty, domain, etc.)

### Manual Browser Investigation

If the script doesn't capture everything, you can manually:

1. Open Chrome DevTools (F12)
2. Go to Network tab
3. Filter by "Fetch/XHR"
4. Navigate to: https://satsuiteeducatorquestionbank.collegeboard.org/digital/search
5. Interact with filters
6. Look for API calls in the Network tab
7. Click on each call to see:
   - Request URL
   - Request Headers
   - Request Payload
   - Response

## Common API Patterns

College Board typically uses patterns like:

```
https://api.collegeboard.org/questionbank/v1/questions?domain=math&difficulty=easy
https://satsuiteeducatorquestionbank.collegeboard.org/api/search
```

## Troubleshooting

### Script doesn't capture API calls

The page might:
- Require authentication (login first)
- Use WebSockets instead of REST API
- Have anti-automation detection

Try:
- Running without headless mode (comment out the headless flag)
- Adding delays between actions
- Manually logging in before running the script

### Chrome driver issues

```bash
# Install/update Chrome driver
pip install --upgrade selenium webdriver-manager
```

Then modify the script to use webdriver-manager:

```python
from webdriver_manager.chrome import ChromeDriverManager
from selenium.webdriver.chrome.service import Service

service = Service(ChromeDriverManager().install())
driver = webdriver.Chrome(service=service, options=chrome_options)
```
