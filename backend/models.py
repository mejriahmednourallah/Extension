from typing import List

from pydantic import BaseModel


class Post(BaseModel):
    id: str
    text: str
    author: str
    post_url: str
    group_name: str
    group_url: str
    timestamp: str


class AnalyzeRequest(BaseModel):
    posts: List[Post]
    client_name: str
    keywords: List[str]
    alert_email: str


class SentimentResult(BaseModel):
    post_id: str
    sentiment: str
    score: float
    category: str
    keywords_matched: List[str]
    bad_buzz_suggestions: List[str]
    should_alert: bool


class AnalyzeResponse(BaseModel):
    results: List[SentimentResult]
    alerts_sent: int
