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
    reactions_count: int = 0
    comments_count: int = 0
    shares_count: int = 0


class AnalyzeRequest(BaseModel):
    posts: List[Post]
    client_name: str
    keywords: List[str]
    alert_email: str
    installation_id: str | None = None


class SentimentResult(BaseModel):
    post_id: str
    sentiment: str
    score: float
    category: str
    keywords_matched: List[str]
    bad_buzz_suggestions: List[str]
    should_alert: bool
    priority_score: float = 0.0
    engagement_total: int = 0


class AnalyzeResponse(BaseModel):
    results: List[SentimentResult]
    alerts_sent: int


class GroupBase(BaseModel):
    name: str
    group_url: str
    enabled: bool = True
    scan_interval_minutes: int = 15
    category: str = "marque"


class GroupCreate(GroupBase):
    pass


class GroupUpdate(BaseModel):
    name: str | None = None
    group_url: str | None = None
    enabled: bool | None = None
    scan_interval_minutes: int | None = None
    category: str | None = None


class ExtensionStateSyncRequest(BaseModel):
    installation_id: str
    client_name: str
    alert_email: str
    auto_scan: bool = True
    keywords: List[str]


class ExtensionStateResponse(BaseModel):
    installation_id: str
    client_name: str
    alert_email: str
    auto_scan: bool
    keywords: List[str]
    synced_at: str


class AlertStatsResponse(BaseModel):
    total_posts: int
    total_posts_today: int
    alerts_today: int
    groups_active_count: int
    avg_score_24h: float
    sentiment_counts_24h: dict
    language_distribution_24h: dict
    daily_sentiment_7d: List[dict]
    last_scan_at: str | None


class BadBuzzItem(BaseModel):
    id: str
    post_text: str
    author: str
    post_url: str
    group_name: str
    group_url: str
    sentiment: str
    score: float
    category: str
    keywords_matched: List[str]
    bad_buzz_suggestions: List[str]
    reactions_count: int
    comments_count: int
    shares_count: int
    engagement_total: int
    priority_score: float
    created_at: str
