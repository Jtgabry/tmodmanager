import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = { children: ReactNode; resetKey?: string }
type State = { error: Error | null; resetKey?: string }

/**
 * Un errore in un componente non deve far sparire tutto il pannello: si mostra un avviso al posto
 * della pagina, che torna normale cambiando pagina (resetKey) o ricaricando.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  /** Cambiando pagina l'errore si azzera (senza rimontare la pagina a ogni cambio di scheda). */
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Errore nella pagina', error, info.componentStack)
  }


  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="alert alert-error">
        <p>Questa pagina ha avuto un errore: {this.state.error.message}</p>
        <button type="button" className="btn btn-sm" onClick={() => location.reload()}>
          Ricarica
        </button>
      </div>
    )
  }
}
