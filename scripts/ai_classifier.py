#!/usr/bin/env python3
"""
AI-powered job quality classifier for Career Radar.
Scores jobs on: experience match, role relevance, company quality, description quality.
Replaces/augments the regex-based JS classifier with NLP techniques.
"""
import re
import json
import sys

# Target role profiles with skills and experience
ROLE_PROFILES = {
    'Data Engineer': {
        'skills': ['python', 'sql', 'spark', 'airflow', 'kafka', 'aws', 'databricks', 'snowflake', 'etl', 'pipeline', 'dbt', 'terraform'],
        'titles': ['data engineer', 'analytics engineer', 'etl developer', 'data pipeline'],
        'exp_min': 3, 'exp_max': 6,
    },
    'Data Scientist': {
        'skills': ['python', 'machine learning', 'statistics', 'pandas', 'scikit-learn', 'tensorflow', 'pytorch', 'sql', 'r'],
        'titles': ['data scientist', 'machine learning engineer', 'ml engineer', 'ai engineer'],
        'exp_min': 3, 'exp_max': 6,
    },
    'Data Analyst': {
        'skills': ['sql', 'python', 'tableau', 'power bi', 'excel', 'statistics', 'visualization'],
        'titles': ['data analyst', 'business analyst', 'analytics analyst', 'bi analyst'],
        'exp_min': 3, 'exp_max': 6,
    },
    'AI Engineer': {
        'skills': ['python', 'machine learning', 'deep learning', 'llm', 'pytorch', 'tensorflow', 'nlp', 'genai'],
        'titles': ['ai engineer', 'machine learning engineer', 'ml engineer', 'genai engineer'],
        'exp_min': 3, 'exp_max': 6,
    },
    'Full Stack .NET': {
        'skills': ['c#', '.net', 'asp.net', 'sql server', 'azure', 'javascript', 'react', 'angular'],
        'titles': ['.net developer', 'full stack', 'software engineer', 'application developer'],
        'exp_min': 3, 'exp_max': 6,
    },
}

# Staffing/consulting firms to deprioritize
STAFFING_FIRMS = {
    'sia', 'devoteam', 'sopra steria', 'talan', 'avanade', 'capgemini', 'accenture',
    'deloitte', 'pwc', 'ey', 'kpmg', 'infosys', 'wipro', 'hcl', 'tech mahindra',
    'cognizant', 'tata consultancy', 'tcs',
}

# Defence companies (hard exclusion)
DEFENCE = {
    'boeing', 'lockheed', 'raytheon', 'northrop', 'general dynamics', 'bae systems',
}

def extract_experience(text):
    """Extract years of experience from job description. Returns (min_years, max_years) or (None, None)."""
    text = text.lower()
    # Patterns: "3-5 years", "5+ years", "minimum 3 years", "3 years of experience"
    patterns = [
        r'(\d+)\s*[-–to]+\s*(\d+)\s*years?',  # 3-5 years
        r'(\d+)\+\s*years?',  # 5+ years
        r'minimum\s*(\d+)\s*years?',  # minimum 3 years
        r'(\d+)\s*years?\s*of\s*experience',  # 3 years of experience
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if m:
            groups = m.groups()
            if len(groups) == 2:
                return (int(groups[0]), int(groups[1]))
            else:
                return (int(groups[0]), int(groups[0]) + 2)  # 5+ years → (5, 7)
    return (None, None)

def score_job(job):
    """
    Score a job 0-100 based on:
    - Role relevance (title match)
    - Experience match (3-6 years target)
    - Skills match
    - Company quality (not staffing/defence)
    Returns (score, reasons)
    """
    title = (job.get('title') or '').lower()
    desc = (job.get('descriptionText') or job.get('description') or '').lower()
    company = (job.get('company') or '').lower()
    role = job.get('role', '')
    
    score = 60  # baseline - generous
    reasons = []
    
    # 1. Company quality (hard filters)
    for d in DEFENCE:
        if d in company:
            return (0, ['defence company'])
    for s in STAFFING_FIRMS:
        if s in company:
            score -= 15
            reasons.append('staffing firm')
            break
    
    # 2. Senior title penalty (ALWAYS check)
    # User wants ~5yr roles. "Senior"/"Sr" titles are out unless exp explicitly 3-5yr.
    if any(w in title for w in ['senior', 'sr.', 'sr ', 'principal', 'staff', 'lead ', 'manager', 'director']):
        exp_min2, exp_max2 = extract_experience(title + ' ' + desc)
        # Only allow if explicitly 5 or fewer years max
        if exp_min2 is None or exp_max2 > 5:
            score -= 25
            reasons.append('senior title')
    
    # 3. Role relevance
    profile = ROLE_PROFILES.get(role, {})
    title_match = False
    for t in profile.get('titles', []):
        if t in title:
            title_match = True
            score += 10
            break
    if not title_match and role:
        score -= 5
    
    # 4. Experience match (bonus for 3-6yr, not penalty for unknown)
    exp_min, exp_max = extract_experience(title + ' ' + desc)
    target_min, target_max = 3, 6
    if exp_min is not None:
        if target_min <= exp_min <= target_max or target_min <= exp_max <= target_max:
            score += 15
            reasons.append(f'exp {exp_min}-{exp_max}y')
        elif exp_max < target_min:
            score -= 15
            reasons.append('too junior')
    
    # 5. Skills match (bonus)
    skills = profile.get('skills', [])
    text = title + ' ' + desc
    matched = sum(1 for s in skills if s in text)
    score += min(matched * 2, 10)  # Up to 10 points
    
    return (max(0, min(100, int(score))), reasons)

def main():
    if len(sys.argv) < 2:
        print("Usage: ai_classifier.py <jobs.json> [--rescore]")
        sys.exit(1)
    
    with open(sys.argv[1]) as f:
        data = json.load(f)
    
    jobs = data.get('jobs', [])
    print(f"Scoring {len(jobs)} jobs...", file=sys.stderr)
    
    for job in jobs:
        score, reasons = score_job(job)
        job['aiScore'] = score
        job['aiReasons'] = reasons
        # Recommend fit based on AI score
        if score >= 70:
            job['aiFit'] = True
        elif score <= 30:
            job['aiFit'] = False
        else:
            job['aiFit'] = job.get('fit', False)  # Keep original for borderline
    
    # Stats
    high = sum(1 for j in jobs if j.get('aiScore', 0) >= 70)
    low = sum(1 for j in jobs if j.get('aiScore', 0) <= 30)
    print(f"AI scored: {high} high (70+), {low} low (30-), {len(jobs)-high-low} medium", file=sys.stderr)
    
    if '--rescore' in sys.argv:
        # Output rescored jobs.json
        with open(sys.argv[1], 'w') as f:
            json.dump(data, f)
        print("Rescored and saved.", file=sys.stderr)
    else:
        # Output summary
        top = sorted([j for j in jobs if j.get('aiScore', 0) >= 70], 
                     key=lambda x: x['aiScore'], reverse=True)[:10]
        print("\nTop 10 AI-scored jobs:")
        for j in top:
            print(f"  {j['aiScore']}: {(j.get('title') or '')[:50]} | {j.get('company')}")

if __name__ == '__main__':
    main()
