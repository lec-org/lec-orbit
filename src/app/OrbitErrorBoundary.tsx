/** Orbit 顶层渲染错误边界：兜底任何渲染异常，防止桌面端出现纯白屏。 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Empty } from '@lec-space/liquidglass';

interface OrbitErrorBoundaryProps {
  children: ReactNode;
}

interface OrbitErrorBoundaryState {
  error: Error | null;
}

export class OrbitErrorBoundary extends Component<OrbitErrorBoundaryProps, OrbitErrorBoundaryState> {
  state: OrbitErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): OrbitErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[orbit:error-boundary]', error, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
          }}
        >
          <Empty
            title="界面加载遇到异常"
            description={this.state.error.message || '请点击下方按钮重新加载工作台。'}
          >
            <Button variant="filled" onClick={this.handleReload}>
              重新加载
            </Button>
          </Empty>
        </div>
      );
    }
    return this.props.children;
  }
}
