#!/usr/bin/env python3
"""
CSV Analysis Script - Multiple approaches to calculate sum of visits
"""
import csv
import pandas as pd

def method1_basic_csv():
    """Basic CSV module approach"""
    total_visits = 0
    with open('/Users/eduardruzga/Downloads/2023-11-17.csv', 'r') as file:
        reader = csv.DictReader(file)
        for row in reader:
            total_visits += int(row['Visits'])
    return total_visits

def method2_pandas():
    """Using pandas for data analysis"""
    try:
        df = pd.read_csv('/Users/eduardruzga/Downloads/2023-11-17.csv')
        return df['Visits'].sum()
    except ImportError:
        return "Pandas not available"

def method3_with_stats():
    """CSV analysis with additional statistics"""
    visits = []
    with open('/Users/eduardruzga/Downloads/2023-11-17.csv', 'r') as file:
        reader = csv.DictReader(file)
        for row in reader:
            visits.append(int(row['Visits']))
    
    total = sum(visits)
    avg = total / len(visits)
    max_visits = max(visits)
    min_visits = min(visits)
    
    return {
        'total': total,
        'count': len(visits),
        'average': round(avg, 2),
        'max': max_visits,
        'min': min_visits
    }

if __name__ == "__main__":
    print("Method 1 (Basic CSV):", f"{method1_basic_csv():,}")
    print("Method 2 (Pandas):", method2_pandas())
    
    stats = method3_with_stats()
    print(f"\nDetailed Statistics:")
    print(f"Total visits: {stats['total']:,}")
    print(f"Number of entries: {stats['count']}")
    print(f"Average visits: {stats['average']:,}")
    print(f"Highest visits: {stats['max']:,}")
    print(f"Lowest visits: {stats['min']:,}")
