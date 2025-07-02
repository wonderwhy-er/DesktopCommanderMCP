#!/usr/bin/env python3
"""
Complex CSV Analysis Example - What I'd do for sophisticated data work
"""
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime
import sqlite3

class CSVAnalyzer:
    def __init__(self, csv_path):
        self.df = pd.read_csv(csv_path)
        self.csv_path = csv_path
    
    def complex_analysis(self):
        """Comprehensive analysis with multiple insights"""
        
        # 1. Data Cleaning & Preparation
        self.df['Visits'] = pd.to_numeric(self.df['Visits'], errors='coerce')
        self.df['Total Share'] = pd.to_numeric(self.df['Total Share'], errors='coerce')
        self.df['Capture Date'] = pd.to_datetime(self.df['Capture Date'])
        
        # 2. Advanced Statistics
        stats = {
            'basic_stats': self.df['Visits'].describe(),
            'percentiles': self.df['Visits'].quantile([0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99]),
            'outliers': self.detect_outliers(),
            'top_performers': self.df.nlargest(10, 'Visits')[['Slug', 'Visits', 'Total Share']],
            'market_concentration': self.calculate_market_concentration(),
        }
        
        return stats
    
    def detect_outliers(self):
        """Detect statistical outliers using IQR method"""
        Q1 = self.df['Visits'].quantile(0.25)
        Q3 = self.df['Visits'].quantile(0.75)
        IQR = Q3 - Q1
        lower_bound = Q1 - 1.5 * IQR
        upper_bound = Q3 + 1.5 * IQR
        
        outliers = self.df[(self.df['Visits'] < lower_bound) | (self.df['Visits'] > upper_bound)]
        return outliers[['Slug', 'Visits']].sort_values('Visits', ascending=False)
    
    def calculate_market_concentration(self):
        """Calculate market concentration metrics"""
        total_visits = self.df['Visits'].sum()
        self.df['Market_Share_Calc'] = self.df['Visits'] / total_visits
        
        # Top 5, 10, 20 concentration
        top_5_share = self.df.nlargest(5, 'Visits')['Market_Share_Calc'].sum()
        top_10_share = self.df.nlargest(10, 'Visits')['Market_Share_Calc'].sum()
        top_20_share = self.df.nlargest(20, 'Visits')['Market_Share_Calc'].sum()
        
        # Herfindahl-Hirschman Index (market concentration)
        hhi = (self.df['Market_Share_Calc'] ** 2).sum() * 10000
        
        return {
            'top_5_concentration': f"{top_5_share:.1%}",
            'top_10_concentration': f"{top_10_share:.1%}",
            'top_20_concentration': f"{top_20_share:.1%}",
            'hhi_index': round(hhi, 2),
            'market_classification': self.classify_market_concentration(hhi)
        }
    
    def classify_market_concentration(self, hhi):
        """Classify market based on HHI"""
        if hhi < 1500:
            return "Competitive Market"
        elif hhi < 2500:
            return "Moderately Concentrated"
        else:
            return "Highly Concentrated"
    
    def time_series_analysis(self):
        """If we had multiple date files, analyze trends"""
        # This would work with multiple CSV files over time
        pass
    
    def export_to_database(self):
        """Export processed data to SQLite for complex queries"""
        conn = sqlite3.connect('csv_analysis.db')
        self.df.to_sql('visits_data', conn, if_exists='replace', index=False)
        
        # Example complex SQL query
        complex_query = """
        SELECT 
            Slug,
            Visits,
            "Total Share",
            CASE 
                WHEN Visits > (SELECT AVG(Visits) * 2 FROM visits_data) THEN 'High Performer'
                WHEN Visits > (SELECT AVG(Visits) FROM visits_data) THEN 'Average Performer'
                ELSE 'Low Performer'
            END as Performance_Category,
            RANK() OVER (ORDER BY Visits DESC) as Visit_Rank,
            ROUND(Visits * 100.0 / (SELECT SUM(Visits) FROM visits_data), 4) as Market_Share_Pct
        FROM visits_data
        ORDER BY Visits DESC
        LIMIT 20;
        """
        
        result = pd.read_sql_query(complex_query, conn)
        conn.close()
        return result
    
    def generate_insights_report(self):
        """Generate automated insights"""
        analysis = self.complex_analysis()
        
        report = f"""
        📊 COMPLEX CSV ANALYSIS REPORT
        ════════════════════════════════
        
        📈 MARKET OVERVIEW:
        • Total Services: {len(self.df)}
        • Total Visits: {self.df['Visits'].sum():,}
        • Market Type: {analysis['market_concentration']['market_classification']}
        
        🏆 TOP PERFORMERS:
        {analysis['top_performers'].to_string(index=False)}
        
        📊 MARKET CONCENTRATION:
        • Top 5 control: {analysis['market_concentration']['top_5_concentration']}
        • Top 10 control: {analysis['market_concentration']['top_10_concentration']}
        • HHI Index: {analysis['market_concentration']['hhi_index']}
        
        🎯 KEY INSIGHTS:
        • Average visits per service: {analysis['basic_stats']['mean']:,.0f}
        • Median visits: {analysis['basic_stats']['50%']:,.0f}
        • Standard deviation: {analysis['basic_stats']['std']:,.0f}
        • 99th percentile: {analysis['percentiles'][0.99]:,.0f}
        
        ⚠️  OUTLIERS DETECTED: {len(analysis['outliers'])} services
        """
        
        return report

# Usage example for complex analysis
def demonstrate_complex_analysis():
    """Show what I'd do for complex CSV work"""
    
    try:
        analyzer = CSVAnalyzer('/Users/eduardruzga/Downloads/2023-11-17.csv')
        
        # Generate comprehensive report
        report = analyzer.generate_insights_report()
        print(report)
        
        # Export to database for SQL queries
        sql_results = analyzer.export_to_database()
        print("\n🗄️  TOP 10 WITH SQL ANALYSIS:")
        print(sql_results.head(10).to_string(index=False))
        
    except Exception as e:
        print(f"Complex analysis requires additional libraries: {e}")
        print("For complex work, I'd recommend: pip install pandas numpy matplotlib seaborn")

if __name__ == "__main__":
    demonstrate_complex_analysis()
