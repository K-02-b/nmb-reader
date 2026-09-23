import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** 兜住渲染期异常，避免整个 SPA 白屏。 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('界面渲染出错：', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="container">
          <div className="card">
            <h3>界面出错了</h3>
            <p className="error-text">{this.state.error.message}</p>
            <div className="row">
              <button className="btn" onClick={() => this.setState({ error: null })}>
                重试
              </button>
              <button className="btn" onClick={() => location.reload()}>
                刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
