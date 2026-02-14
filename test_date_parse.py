"""Test parsing attendance date strings."""
from datetime import datetime
import re

dates = [
    "Wed 4 Feb 2026 11:05AM - 12PM",
    "Thu 5 Feb 2026 2PM - 3PM",
    "Fri 6 Feb 2026 9AM - 10AM"
]

def parse_date(date_str):
    # Extract "4 Feb 2026"
    # The format seems to be: Day D Mon YYYY Time - Time
    # Regex: \w+ (\d+ \w+ \d{4})
    match = re.search(r"\w+ (\d+ \w+ \d{4})", date_str)
    if match:
        d_str = match.group(1)
        try:
            dt = datetime.strptime(d_str, "%d %b %Y")
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            return None
    return None

for d in dates:
    print(f"Original: {d} -> Parsed: {parse_date(d)}")
